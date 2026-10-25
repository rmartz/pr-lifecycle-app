import type { CheckStatus, GitHubClient, PolicyEvaluation } from '@rmartz/pr-policy';

/**
 * Telling whether a pr-policy verdict is already posted, so a re-evaluation
 * that changes nothing writes nothing. Most re-evaluations are repeats: the
 * actor re-posts its unchanged `pr-lifecycle/sign-off` status on every
 * reconcile, and each one re-evaluates. Posting the verdict and its per-check
 * statuses again would cost about ten writes for no change.
 */

/** A commit status as the gate posts it. */
export interface PostedStatus {
  readonly context: string;
  readonly state: string;
  readonly description: string;
}

/** GitHub rejects a commit-status description longer than this; the library truncates to it. */
const STATUS_DESCRIPTION_MAX = 140;

/** The statuses an evaluation posts under `name`: the verdict, then one per check. */
export function wantedStatuses(
  name: string,
  evaluation: PolicyEvaluation,
  checks: readonly CheckStatus[],
): PostedStatus[] {
  return [
    {
      context: name,
      state: evaluation.outcome,
      description: evaluation.title.slice(0, STATUS_DESCRIPTION_MAX),
    },
    ...checks.map(({ check, state, description }) => ({
      context: `${name} / ${check}`,
      state,
      description,
    })),
  ];
}

/**
 * Whether every wanted status is already the latest of its context on `sha`,
 * **posted by the gate itself** (`botLogin`). Another poster's identical status
 * doesn't count: during a cutover the repo's workflow posts the same verdict
 * under the same name, and the required check accepts only the gate App's. One
 * read: the head's statuses, newest first. Any doubt, such as an unreadable
 * list, is false, so the verdict is posted.
 */
export async function alreadyPosted(
  client: GitHubClient,
  repo: string,
  sha: string,
  botLogin: string,
  wanted: readonly PostedStatus[],
): Promise<boolean> {
  const out = (await client.getJson(`repos/${repo}/commits/${sha}/statuses?per_page=100`)) as
    | {
        context: string;
        state: string;
        description: string | null;
        creator: { login: string } | null;
      }[]
    | null;
  if (!Array.isArray(out)) return false;
  const latest = new Map<string, (typeof out)[number]>();
  for (const status of out) {
    if (!latest.has(status.context)) latest.set(status.context, status);
  }
  const bot = botLogin.toLowerCase();
  return wanted.every((status) => {
    const posted = latest.get(status.context);
    return (
      posted?.creator?.login.toLowerCase() === bot &&
      posted.state === status.state &&
      (posted.description ?? '') === status.description
    );
  });
}
