import type { EventRepository, EventTarget } from './events.js';
import type { MergeSafetyConfig, MergeSafetyDeps, Run } from './merge-safety-evaluate.js';
import { describe, evaluateOne, mergeSafetyName } from './merge-safety-evaluate.js';
import { openPullsOnBase, postCheck } from './merge-safety-io.js';
import { forEachBounded } from './rate-limit.js';

/**
 * Below this many requests left in the installation's hour, a fan-out stops
 * evaluating. The PRs it didn't reach keep their pending mark, which holds the
 * merge, and the next base event or a Re-run picks them up.
 */
export const RATE_LIMIT_FLOOR = 500;

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

/** Whether `sha` is still the tip of `branch`; undefined when the branch can't be read. */
async function isTip(run: Run, branch: string, sha: string): Promise<boolean | undefined> {
  const out = (await run.client.getJson(
    `repos/${run.repo}/branches/${encodeURIComponent(branch)}`,
  )) as { commit: { sha: string } } | null;
  return out === null ? undefined : out.commit.sha === sha;
}

async function invalidate(run: Run, baseBranch: string, tipSha: string | undefined): Promise<void> {
  const { config, deps } = run;
  const context = { ...run.context, baseBranch };
  if (tipSha !== undefined) {
    const current = await isTip(run, baseBranch, tipSha);
    if (current !== true) {
      const fields = { ...context, tipSha, failure: deps.lastFailure() ?? null };
      if (current === undefined) {
        deps.log.error('could not read the base branch', fields);
      } else {
        deps.log.info('skipped a base CI run that is no longer the tip', fields);
      }
      return;
    }
  }
  const pulls = await openPullsOnBase(run.client, run.repo, baseBranch);
  if (pulls === undefined) {
    deps.log.error('could not list the open PRs on the moved base', {
      ...context,
      failure: deps.lastFailure() ?? null,
    });
    return;
  }
  if (belowFloor(deps)) {
    deps.log.warn('skipped an invalidation at the rate-limit floor', {
      ...context,
      rateLimitRemaining: deps.rateLimitRemaining() ?? null,
    });
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
    if (stopped || belowFloor(deps)) {
      stopped = true;
      return;
    }
    await evaluateOne(run, number);
  });
  const fields = {
    ...context,
    prs: pulls.length,
    rateLimitRemaining: deps.rateLimitRemaining() ?? null,
  };
  if (stopped) {
    deps.log.warn('fan-out stopped at the rate-limit floor; the rest stay pending', fields);
  } else {
    deps.log.info('invalidated', fields);
  }
}

function belowFloor(deps: MergeSafetyDeps): boolean {
  const remaining = deps.rateLimitRemaining();
  return remaining !== undefined && remaining < RATE_LIMIT_FLOOR;
}

async function openPullsAtHead(run: Run, sha: string): Promise<number[] | undefined> {
  const pulls = await run.client.list(`repos/${run.repo}/commits/${sha}/pulls`);
  if (pulls === null) return undefined;
  return (pulls as { number: number; state: string }[])
    .filter((pull) => pull.state === 'open')
    .map((pull) => pull.number);
}
