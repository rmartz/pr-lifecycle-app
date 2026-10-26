import { createHash } from 'node:crypto';
import { failingBaseChecks } from '@rmartz/merge-safety';
import type { GitHubClient } from '@rmartz/pr-policy';
import { baseChecksProbe, requiredChecksProbe } from './merge-safety-io.js';

/**
 * Telling whether a PR's merge-safety verdict is still current, so a base event
 * re-evaluates only the PRs it can change.
 *
 * A verdict depends on the PR (its head, title, mergeability and `hotfix`
 * label) and on the base: its tip, and which of its checks base health counts as
 * failing. PR changes arrive as PR events, which always re-evaluate. The
 * base side is summed up as a **base key**, stored on the check-run as its
 * `external_id`. An invalidation skips every PR whose latest gate check-run
 * carries the current key: re-evaluating it would post the same verdict. That
 * includes a pending verdict (`Update required` posts an in-progress run).
 * The invalidation's own pending mark carries `REEVALUATING_ID` instead, so a
 * PR left marked by a stopped fan-out is never mistaken for a verdict.
 */

/** The `external_id` of an invalidation's `Re-evaluating` mark: never a base key. */
export const REEVALUATING_ID = 're-evaluating';

/**
 * The base key for `branch`: its tip SHA plus a digest of the base checks base
 * health counts as failing, classified by the library (`failingBaseChecks`). A
 * check going from pending to green, or a non-required check finishing, leaves
 * the key unchanged, so the CI runs that finish after every push cost no
 * fan-out. Undefined when the tip can't be read.
 */
export async function baseKey(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const tip = await branchTip(client, repo, branch);
  if (tip === undefined) return undefined;
  const required = await requiredChecksProbe(client, repo)(branch);
  const runs = await baseChecksProbe(client, repo)(tip);
  const failing = failingBaseChecks(runs, required).sort().join('\n');
  return `${tip}:${createHash('sha256').update(failing).digest('hex').slice(0, 12)}`;
}

/** The tip SHA of `branch`, or undefined when it can't be read. */
export async function branchTip(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const out = (await client.getJson(`repos/${repo}/branches/${encodeURIComponent(branch)}`)) as {
    commit: { sha: string };
  } | null;
  return out?.commit.sha;
}

/**
 * Whether the gate's latest `name` check-run on `headSha` is a verdict, completed
 * or pending, computed against `key`. Any doubt (no run, an invalidation's mark,
 * another key, unreadable) is false, so the PR is re-evaluated.
 */
export async function isCurrentVerdict(
  client: GitHubClient,
  repo: string,
  headSha: string,
  name: string,
  key: string,
): Promise<boolean> {
  const runs = await client.list(
    `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`,
    'check_runs',
  );
  const latest = (runs ?? [])[0] as { external_id: string | null } | undefined;
  return latest !== undefined && latest.external_id === key;
}
