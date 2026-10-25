import type { MergeSafetyDecision } from '@rmartz/merge-safety';
import {
  errorMergeSafetyDecision,
  evaluateMergeSafety,
  gatherMergeSafetyFacts,
  makeApiGitRunner,
  MERGE_SAFETY_CHECK_NAME,
} from '@rmartz/merge-safety';
import type { GitHubClient } from '@rmartz/pr-policy';
import type { MintToken } from './installation-token.js';
import type { LogFields, Logger } from './logger.js';
import { baseChecksProbe, postCheck, readPr, requiredChecksProbe } from './merge-safety-io.js';
import type { RequestFailure } from './rate-limit.js';
import { isStarved } from './rate-limit.js';
import { baseKey } from './merge-safety-dedupe.js';
import type { ActiveToolConfig, MergeSafetyPolicy } from './repos.js';

/**
 * Evaluating merge-safety on one PR, as the gate: the library's verdict over its
 * API fact source, posted as the check, with the labels reconciled when live.
 * The event-level runs (evaluate, invalidate) are in ./run-merge-safety.ts.
 */

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
  /** The client's latest failed response (status and path), for logging a failed read. */
  readonly lastFailure: () => RequestFailure | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly log: Logger;
}

/** The check name in each mode. */
export function mergeSafetyName(config: MergeSafetyConfig): string {
  return config.mode === 'live' ? MERGE_SAFETY_CHECK_NAME : MERGE_SAFETY_SHADOW_NAME;
}

/** One run's client, repo, config, log context and deps. */
export interface Run {
  readonly client: GitHubClient;
  readonly repo: string;
  readonly config: MergeSafetyConfig;
  readonly context: LogFields;
  readonly deps: MergeSafetyDeps;
}

/** Whether the run's client is out of budget (./rate-limit.ts). */
export function starved(deps: MergeSafetyDeps): boolean {
  return isStarved(deps.rateLimitRemaining(), deps.lastFailure());
}

/**
 * Evaluates one PR and posts its check, stamped with the base key it was
 * computed against (`key`, or computed here). Out of budget, it posts nothing:
 * a verdict from rate-limited reads would be a false `Could not evaluate`,
 * which once live is a red required check. Never throws.
 */
export async function evaluateOne(run: Run, pr: number, key?: string): Promise<void> {
  const { client, repo, config, deps } = run;
  const context = { ...run.context, pr };
  const skip = (message: string) =>
    deps.log.warn(message, {
      ...context,
      rateLimitRemaining: deps.rateLimitRemaining() ?? null,
      failure: deps.lastFailure() ?? null,
    });
  try {
    if (starved(deps)) {
      skip('skipped an evaluation: the installation is out of API budget');
      return;
    }
    const view = await readPr(client, repo, pr, deps.sleep);
    if (view === undefined && starved(deps)) {
      skip('skipped an evaluation: the installation is out of API budget');
      return;
    }
    if (view === undefined) {
      deps.log.error('could not read the pull request', {
        ...context,
        failure: deps.lastFailure() ?? null,
      });
      return;
    }
    if (view.state !== 'OPEN') {
      deps.log.info('skipped a pull request that is not open', { ...context, state: view.state });
      return;
    }
    const { decision, gathered } = await decide(run, view.meta, view.baseBranch);
    if (!gathered && starved(deps)) {
      skip('skipped a verdict the rate limit cut short; nothing posted');
      return;
    }
    const externalId = key ?? (await baseKey(client, repo, view.baseBranch));
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
        ...(externalId === undefined ? {} : { externalId }),
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
    deps.log.error('merge-safety evaluation failed', {
      ...context,
      error: describe(error),
      failure: deps.lastFailure() ?? null,
    });
  }
}

/**
 * The library's verdict, or its fail-safe `Could not evaluate` when facts can't
 * be gathered (`gathered: false`, so a caller can tell a starved read apart).
 */
async function decide(
  run: Run,
  meta: Parameters<typeof gatherMergeSafetyFacts>[0],
  baseBranch: string,
): Promise<{ decision: MergeSafetyDecision; gathered: boolean }> {
  try {
    const facts = await gatherMergeSafetyFacts(meta, {
      baseRef: baseBranch,
      git: makeApiGitRunner({ repo: run.repo, api: (path) => run.client.getJson(path) }),
      baseChecks: baseChecksProbe(run.client, run.repo),
      requiredChecks: requiredChecksProbe(run.client, run.repo),
    });
    return { decision: evaluateMergeSafety(facts), gathered: true };
  } catch (error) {
    return { decision: errorMergeSafetyDecision(describe(error)), gathered: false };
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
