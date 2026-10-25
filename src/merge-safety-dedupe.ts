import { createHash } from 'node:crypto';
import type { GitHubClient } from '@rmartz/pr-policy';
import { baseChecksProbe, requiredChecksProbe } from './merge-safety-io.js';

/**
 * Telling whether a PR's merge-safety verdict is still current, so a base event
 * re-evaluates only the PRs it can change.
 *
 * A verdict depends on the PR (its head, title, mergeability and `hotfix`
 * label) and on the base: its tip, and the conclusions of its required checks
 * (base health). PR changes arrive as PR events, which always re-evaluate. The
 * base side is summed up as a **base key**, stored on the check-run as its
 * `external_id`. An invalidation skips every PR whose latest gate check-run is
 * completed with the current key: re-evaluating it would post the same verdict.
 */

/**
 * The base key for `branch`: its tip SHA plus a digest of its required checks'
 * latest conclusions on that tip. A non-required check finishing doesn't change
 * it, so it costs no fan-out. Undefined when the tip can't be read.
 */
export async function baseKey(
  client: GitHubClient,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const tip = await branchTip(client, repo, branch);
  if (tip === undefined) return undefined;
  const required = (await requiredChecksProbe(client, repo)(branch)) ?? [];
  const runs = await baseChecksProbe(client, repo)(tip);
  const state = [...required]
    .sort()
    .map((name) => `${name}=${runs.find((run) => run.name === name)?.conclusion ?? 'none'}`)
    .join('\n');
  return `${tip}:${createHash('sha256').update(state).digest('hex').slice(0, 12)}`;
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
 * Whether the gate's latest `name` check-run on `headSha` is a completed verdict
 * computed against `key`. Any doubt (no run, still pending, unreadable) is false,
 * so the PR is re-evaluated.
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
  const latest = (runs ?? [])[0] as { status: string; external_id: string | null } | undefined;
  return latest?.status === 'completed' && latest.external_id === key;
}
