import type { MergeSafetyDecision } from '@rmartz/merge-safety';
import {
  errorMergeSafetyDecision,
  evaluateMergeSafety,
  gatherMergeSafetyFacts,
  makeApiGitRunner,
  MERGE_SAFETY_CHECK_NAME,
} from '@rmartz/merge-safety';
import type { GitHubClient } from '@rmartz/pr-policy';
import type { EventRepository, EventTarget } from './events.js';
import type { MintToken } from './installation-token.js';
import type { LogFields, Logger } from './logger.js';
import {
  baseChecksProbe,
  openPullsOnBase,
  postCheck,
  readPr,
  requiredChecksProbe,
} from './merge-safety-io.js';
import { forEachBounded } from './rate-limit.js';
import type { ActiveToolConfig, MergeSafetyPolicy } from './repos.js';

/** merge-safety's settings for a repo it acts on. */
export type MergeSafetyConfig = ActiveToolConfig<MergeSafetyPolicy>;

/** The name the gate posts under while shadowing, never the required `merge-safety`. */
export const MERGE_SAFETY_SHADOW_NAME = 'merge-safety (app)';

/**
 * Below this many requests left in the installation's hour, a fan-out stops
 * evaluating. The PRs it didn't reach keep their pending mark, which holds the
 * merge, and the next base event or a Re-run picks them up.
 */
export const RATE_LIMIT_FLOOR = 500;

export interface MergeSafetyDeps {
  /** Mints a token with the gate's permissions, scoped to the event's repository. */
  readonly mintToken: MintToken;
  readonly createClient: (token: string) => GitHubClient;
  /** The latest `x-ratelimit-remaining` the client saw. */
  readonly rateLimitRemaining: () => number | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly log: Logger;
}

/** The check name in each mode. */
export function mergeSafetyName(config: MergeSafetyConfig): string {
  return config.mode === 'live' ? MERGE_SAFETY_CHECK_NAME : MERGE_SAFETY_SHADOW_NAME;
}

interface Run {
  readonly client: GitHubClient;
  readonly repo: string;
  readonly config: MergeSafetyConfig;
  readonly context: LogFields;
  readonly deps: MergeSafetyDeps;
}

async function prepare(
  repository: EventRepository,
  config: MergeSafetyConfig,
  deliveryId: string,
  deps: MergeSafetyDeps,
): Promise<Run | undefined> {
  const context = { delivery: deliveryId, repo: repository.fullName, tool: 'merge-safety' };
  try {
    const token = await deps.mintToken(repository.installationId, repository.name);
    return { client: deps.createClient(token), repo: repository.fullName, config, context, deps };
  } catch (error) {
    deps.log.error('could not prepare the merge-safety run', {
      ...context,
      error: describe(error),
    });
    return undefined;
  }
}

/**
 * Evaluates merge-safety on the PRs an event names (or the open PRs at its head
 * SHA, for a Re-run with no listed PR). Never throws.
 */
export async function runMergeSafetyEvaluate(
  target: EventTarget,
  config: MergeSafetyConfig,
  deliveryId: string,
  deps: MergeSafetyDeps,
): Promise<void> {
  const run = await prepare(target.repository, config, deliveryId, deps);
  if (run === undefined) return;
  try {
    await evaluateTargets(run, target);
  } catch (error) {
    deps.log.error('merge-safety run failed', { ...run.context, error: describe(error) });
  }
}

async function evaluateTargets(run: Run, target: EventTarget): Promise<void> {
  let prs = target.prs;
  if (prs.length === 0 && target.headSha !== undefined) {
    const pulls = await openPullsAtHead(run, target.headSha);
    prs = pulls ?? [];
  }
  for (const pr of [...new Set(prs)].sort((a, b) => a - b)) {
    await evaluateOne(run, pr);
  }
}

/**
 * A base branch moved: mark every open PR on it pending at once (holding its
 * merge), then re-evaluate them in place with bounded concurrency, stopping at
 * the rate-limit floor. Replaces the workflow's per-PR `workflow_dispatch`.
 */
export async function runMergeSafetyInvalidate(
  repository: EventRepository,
  baseBranch: string,
  config: MergeSafetyConfig,
  deliveryId: string,
  deps: MergeSafetyDeps,
): Promise<void> {
  const run = await prepare(repository, config, deliveryId, deps);
  if (run === undefined) return;
  try {
    await invalidate(run, baseBranch);
  } catch (error) {
    deps.log.error('merge-safety run failed', {
      ...run.context,
      baseBranch,
      error: describe(error),
    });
  }
}

async function invalidate(run: Run, baseBranch: string): Promise<void> {
  const { config, deps } = run;
  const pulls = await openPullsOnBase(run.client, run.repo, baseBranch);
  if (pulls === undefined) {
    deps.log.error('could not list the open PRs on the moved base', { ...run.context, baseBranch });
    return;
  }
  const name = mergeSafetyName(config);
  for (const pull of pulls) {
    await postCheck(
      run.client,
      run.repo,
      pull.headSha,
      {
        name,
        conclusion: 'pending',
        title: 'Re-evaluating',
        summary: 'Re-evaluating against the updated base…',
      },
      deps.now(),
    );
  }
  let stopped = false;
  await forEachBounded(pulls, config.policy.concurrency, async ({ number }) => {
    const remaining = deps.rateLimitRemaining();
    if (stopped || (remaining !== undefined && remaining < RATE_LIMIT_FLOOR)) {
      stopped = true;
      return;
    }
    await evaluateOne(run, number);
  });
  const fields = {
    ...run.context,
    baseBranch,
    prs: pulls.length,
    rateLimitRemaining: deps.rateLimitRemaining() ?? null,
  };
  if (stopped) {
    deps.log.warn('fan-out stopped at the rate-limit floor; the rest stay pending', fields);
  } else {
    deps.log.info('invalidated', fields);
  }
}

async function openPullsAtHead(run: Run, sha: string): Promise<number[] | undefined> {
  const pulls = await run.client.list(`repos/${run.repo}/commits/${sha}/pulls`);
  if (pulls === null) return undefined;
  return (pulls as { number: number; state: string }[])
    .filter((pull) => pull.state === 'open')
    .map((pull) => pull.number);
}

async function evaluateOne(run: Run, pr: number): Promise<void> {
  const { client, repo, config, deps } = run;
  const context = { ...run.context, pr };
  try {
    const view = await readPr(client, repo, pr, deps.sleep);
    if (view === undefined) {
      deps.log.error('could not read the pull request', context);
      return;
    }
    if (view.state !== 'OPEN') {
      deps.log.info('skipped a pull request that is not open', { ...context, state: view.state });
      return;
    }
    const decision = await decide(run, view.meta, view.baseBranch);
    const name = mergeSafetyName(config);
    const detail = decision.reasons.length
      ? decision.reasons.map((reason) => `- ${reason}`).join('\n')
      : decision.summary;
    const posted = await postCheck(
      client,
      repo,
      view.meta.headSha,
      {
        name,
        conclusion: decision.conclusion,
        title: decision.title,
        summary: `${decision.summary}\n\n${detail}`,
      },
      deps.now(),
    );
    if (config.mode === 'live') {
      if (decision.labels.add.length > 0) {
        await client.addLabels(repo, pr, decision.labels.add);
      }
      for (const label of decision.labels.remove) {
        await client.removeLabel(repo, pr, label);
      }
    }
    deps.log.info('evaluated', {
      ...context,
      mode: config.mode,
      name,
      conclusion: decision.conclusion,
      title: decision.title,
      posted,
      rateLimitRemaining: deps.rateLimitRemaining() ?? null,
    });
  } catch (error) {
    deps.log.error('merge-safety evaluation failed', { ...context, error: describe(error) });
  }
}

/** The library's verdict, or its fail-safe `Could not evaluate` when facts can't be gathered. */
async function decide(
  run: Run,
  meta: Parameters<typeof gatherMergeSafetyFacts>[0],
  baseBranch: string,
): Promise<MergeSafetyDecision> {
  try {
    const facts = await gatherMergeSafetyFacts(meta, {
      baseRef: baseBranch,
      git: makeApiGitRunner({ repo: run.repo, api: (path) => run.client.getJson(path) }),
      baseChecks: baseChecksProbe(run.client, run.repo),
      requiredChecks: requiredChecksProbe(run.client, run.repo),
    });
    return evaluateMergeSafety(facts);
  } catch (error) {
    return errorMergeSafetyDecision(describe(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
