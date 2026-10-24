import type {
  BaseCheckRun,
  BaseChecksProbe,
  PrMergeMeta,
  RequiredChecksProbe,
} from '@rmartz/merge-safety';
import type { GitHubClient } from '@rmartz/pr-policy';

/**
 * merge-safety's GitHub reads and writes over the gate's `GitHubClient`. The
 * library owns the verdict and the git facts (its API fact source); this is the
 * glue its CLI does with `gh`: read the PR, probe the base, post the check and
 * reconcile its labels.
 */

/** A PR as the evaluation needs it, or undefined when it can't be read. */
export interface PrView {
  readonly meta: PrMergeMeta;
  readonly state: string;
  readonly baseBranch: string;
}

interface PullShape {
  state: string;
  merged?: boolean;
  title: string;
  head: { sha: string };
  base: { ref: string };
  labels: { name: string }[];
  /** `null` while GitHub is still computing it. */
  mergeable: boolean | null;
}

function mergeableOf(mergeable: boolean | null): string {
  if (mergeable === null) return 'UNKNOWN';
  return mergeable ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * Reads a PR, re-reading while GitHub computes `mergeable` lazily (as the CLI
 * does), up to `attempts` reads. A still-unknown result is passed on as
 * `UNKNOWN`, which the library treats as not known to conflict.
 */
export async function readPr(
  client: GitHubClient,
  repo: string,
  pr: number,
  sleep: (ms: number) => Promise<void>,
  attempts = 3,
): Promise<PrView | undefined> {
  for (let attempt = 1; ; attempt++) {
    const out = (await client.getJson(`repos/${repo}/pulls/${pr}`)) as PullShape | null;
    if (out === null) return undefined;
    if (out.mergeable !== null || attempt >= attempts) {
      return {
        state: out.merged === true ? 'MERGED' : out.state.toUpperCase(),
        baseBranch: out.base.ref,
        meta: {
          headSha: out.head.sha,
          title: out.title,
          labels: out.labels.map((label) => label.name),
          mergeable: mergeableOf(out.mergeable),
        },
      };
    }
    await sleep(2000);
  }
}

/**
 * The base tip's check-runs, latest per name. Soft-fails to `[]`, as the CLI's
 * probe does, so an unreadable base never reads as failing.
 */
export function baseChecksProbe(client: GitHubClient, repo: string): BaseChecksProbe {
  return async (baseSha) => {
    const runs = await client.list(
      `repos/${repo}/commits/${baseSha}/check-runs?filter=latest`,
      'check_runs',
    );
    return ((runs ?? []) as RunShape[]).map((run): BaseCheckRun => ({
      name: run.name,
      conclusion: run.conclusion,
      appSlug: run.app?.slug ?? null,
    }));
  };
}

interface RunShape {
  name: string;
  conclusion: string | null;
  app: { slug: string } | null;
}

/**
 * The base branch's required status-check contexts from the rulesets that apply
 * to it, or `null` when they can't be read (base health then gates nothing).
 */
export function requiredChecksProbe(client: GitHubClient, repo: string): RequiredChecksProbe {
  return async (baseBranch) => {
    const rules = await client.list(
      `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
    );
    if (rules === null) return null;
    const contexts = (rules as RuleShape[])
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context);
    return [...new Set(contexts)];
  };
}

interface RuleShape {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

/** What a check posts: its conclusion and the check-run output. */
export interface CheckPost {
  readonly name: string;
  readonly conclusion: 'success' | 'failure' | 'pending';
  readonly title: string;
  readonly summary: string;
}

/** GitHub rejects a commit-status description longer than this. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Posts the check on `headSha` the way the CLI does: complete every still-open
 * run of that name in place (so an invalidation's pending run isn't orphaned),
 * or create one, then mirror it to a commit status of the same name. `pending`
 * posts an in-progress run, which holds the merge without rendering red.
 */
export async function postCheck(
  client: GitHubClient,
  repo: string,
  headSha: string,
  post: CheckPost,
  now: Date,
): Promise<boolean> {
  const output = { title: post.title, summary: post.summary };
  const state =
    post.conclusion === 'pending'
      ? { status: 'in_progress', output }
      : {
          status: 'completed',
          conclusion: post.conclusion,
          completed_at: now.toISOString(),
          output,
        };
  const runs = await client.list(
    `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(post.name)}&filter=all`,
    'check_runs',
  );
  const open = ((runs ?? []) as { id: number; status: string }[]).filter(
    (run) => run.status !== 'completed',
  );
  let posted = false;
  for (const run of open) {
    posted =
      (await client.send('PATCH', `repos/${repo}/check-runs/${run.id}`, state)) !== null || posted;
  }
  if (!posted) {
    posted =
      (await client.send('POST', `repos/${repo}/check-runs`, {
        name: post.name,
        head_sha: headSha,
        ...state,
      })) !== null;
  }
  const status = await client.send('POST', `repos/${repo}/statuses/${headSha}`, {
    state: post.conclusion,
    context: post.name,
    description: post.title.slice(0, STATUS_DESCRIPTION_MAX),
  });
  return posted && status !== null;
}

/** The open PRs based on `branch`, with their head SHAs, or undefined when unreadable. */
export async function openPullsOnBase(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<{ number: number; headSha: string }[] | undefined> {
  const pulls = await client.list(
    `repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`,
  );
  if (pulls === null) return undefined;
  return (pulls as { number: number; head: { sha: string } }[]).map((pull) => ({
    number: pull.number,
    headSha: pull.head.sha,
  }));
}
