import type { EventRepository, EventTarget } from './events.js';
import type { MergeSafetyConfig, MergeSafetyDeps, Run } from './merge-safety-evaluate.js';
import { describe, evaluateOne, mergeSafetyName, starved } from './merge-safety-evaluate.js';
import { baseKey, branchTip, isCurrentVerdict, REEVALUATING_ID } from './merge-safety-dedupe.js';
import { openPullsOnBase, postCheck } from './merge-safety-io.js';
import { memoizeReads } from './memo-client.js';
import { forEachBounded } from './rate-limit.js';

async function prepare(
  repository: EventRepository,
  config: MergeSafetyConfig,
  deliveryId: string,
  deps: MergeSafetyDeps,
): Promise<Run | undefined> {
  const context = { delivery: deliveryId, repo: repository.fullName, tool: 'merge-safety' };
  try {
    const token = await deps.mintToken(repository.installationId, repository.name);
    const client = memoizeReads(deps.createClient(token));
    return { client, repo: repository.fullName, config, context, deps };
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
    deps.log.error('merge-safety run failed', {
      ...run.context,
      error: describe(error),
      failure: deps.lastFailure() ?? null,
    });
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
  tipSha: string | undefined,
  config: MergeSafetyConfig,
  deliveryId: string,
  deps: MergeSafetyDeps,
): Promise<void> {
  const run = await prepare(repository, config, deliveryId, deps);
  if (run === undefined) return;
  try {
    await invalidate(run, baseBranch, tipSha);
  } catch (error) {
    deps.log.error('merge-safety run failed', {
      ...run.context,
      baseBranch,
      error: describe(error),
      failure: deps.lastFailure() ?? null,
    });
  }
}

/**
 * The fan-out: only the PRs whose latest gate verdict wasn't computed against
 * the current base key are marked pending and re-evaluated. A base event that
 * changed nothing a verdict reads (a stale CI run, a non-required check, a
 * redelivery) costs a few shared reads and posts nothing.
 */
async function invalidate(run: Run, baseBranch: string, tipSha: string | undefined): Promise<void> {
  const { config, deps } = run;
  const context = { ...run.context, baseBranch };
  const failed = (message: string) =>
    deps.log.error(message, { ...context, failure: deps.lastFailure() ?? null });
  const tip = await branchTip(run.client, run.repo, baseBranch);
  if (tip !== undefined && tipSha !== undefined && tip !== tipSha) {
    deps.log.info('skipped a base CI run that is no longer the tip', { ...context, tipSha });
    return;
  }
  // The key re-reads the tip through the cache, so this costs no extra call.
  const key = tip === undefined ? undefined : await baseKey(run.client, run.repo, baseBranch);
  if (key === undefined) {
    failed('could not read the base branch');
    return;
  }
  const pulls = await openPullsOnBase(run.client, run.repo, baseBranch);
  if (pulls === undefined) {
    failed('could not list the open PRs on the moved base');
    return;
  }
  const name = mergeSafetyName(config);
  const stale = [];
  for (const pull of pulls) {
    if (!(await isCurrentVerdict(run.client, run.repo, pull.headSha, name, key))) {
      stale.push(pull);
    }
  }
  if (stale.length > 0 && starved(deps)) {
    deps.log.warn('skipped an invalidation: the installation is out of API budget', {
      ...context,
      rateLimitRemaining: deps.rateLimitRemaining() ?? null,
    });
    return;
  }
  for (const pull of stale) {
    await postCheck(
      run.client,
      run.repo,
      pull.headSha,
      {
        name,
        conclusion: 'pending',
        title: 'Re-evaluating',
        summary: 'Re-evaluating against the updated base…',
        externalId: REEVALUATING_ID,
      },
      deps.now(),
    );
  }
  let stopped = false;
  await forEachBounded(stale, config.policy.concurrency, async ({ number }) => {
    if (stopped || starved(deps)) {
      stopped = true;
      return;
    }
    await evaluateOne(run, number, key);
  });
  const fields = {
    ...context,
    prs: pulls.length,
    reevaluated: stale.length,
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
