import type {
  CheckStatus,
  CheckStatusOptions,
  GitHubClient,
  PolicyCheck,
  PolicyEvaluation,
  PullRequestFacts,
  PullRequestTarget,
  VerdictOptions,
} from '@rmartz/pr-policy';
import { checkStatuses, ciRetitle, PR_POLICY_CHECK_NAME, selectChecks } from '@rmartz/pr-policy';
import type { EventTarget } from './events.js';
import type { MintToken } from './installation-token.js';
import type { LogFields, Logger } from './logger.js';
import type { ActiveToolConfig, PrPolicyPolicy } from './repos.js';

/** pr-policy's settings for a repo it acts on. */
export type PrPolicyConfig = ActiveToolConfig<PrPolicyPolicy>;

/**
 * The name the gate posts under while shadowing: never the real `pr-policy`,
 * which the repo's action still posts. Two creators posting one context would
 * overwrite each other.
 */
export const PR_POLICY_SHADOW_NAME = 'pr-policy (app)';

/** The library's GitHub I/O, injected so a run is testable without the network. */
export interface PolicyIo {
  readonly gatherFacts: (
    target: PullRequestTarget,
  ) => Promise<{ facts: PullRequestFacts; headSha: string }>;
  readonly openPullRequestsAtHead: (
    target: { repo: string; client: GitHubClient },
    sha: string,
  ) => Promise<number[]>;
  readonly evaluatePolicy: (
    facts: PullRequestFacts,
    checks: readonly PolicyCheck[],
  ) => Promise<PolicyEvaluation>;
  readonly applyLabelEdits: (
    target: PullRequestTarget,
    evaluation: PolicyEvaluation,
  ) => Promise<void>;
  readonly postVerdict: (
    target: PullRequestTarget,
    headSha: string,
    evaluation: PolicyEvaluation,
    options: VerdictOptions,
  ) => Promise<void>;
  readonly postCheckStatuses: (
    target: { repo: string; client: GitHubClient },
    sha: string,
    statuses: readonly CheckStatus[],
    options: CheckStatusOptions,
  ) => Promise<boolean>;
}

export interface PrPolicyDeps {
  /** Mints a token with the gate's permissions, scoped to the event's repository. */
  readonly mintToken: MintToken;
  readonly createClient: (token: string) => GitHubClient;
  readonly policy: PolicyIo;
  readonly log: Logger;
}

/** The name the verdict and per-check statuses are posted under in each mode. */
export function verdictName(config: PrPolicyConfig): string {
  return config.mode === 'live' ? PR_POLICY_CHECK_NAME : PR_POLICY_SHADOW_NAME;
}

/**
 * Evaluates pr-policy on every PR an event targets, as the gate App, with a token
 * minted for the event's own installation and repository. Live, it does what the
 * repo's action did: retitle, label edits, the `pr-policy` verdict and the
 * per-check statuses. Shadow, it changes nothing on the PR and posts under
 * `pr-policy (app)`, judging the retitled title so the verdict is comparable.
 * Never throws: a failure is logged, and the next event re-evaluates.
 */
export async function runPrPolicy(
  target: EventTarget,
  config: PrPolicyConfig,
  deliveryId: string,
  deps: PrPolicyDeps,
): Promise<void> {
  const { repository } = target;
  const context = { delivery: deliveryId, repo: repository.fullName, tool: 'pr-policy' };
  let client: GitHubClient;
  let prs: readonly number[];
  try {
    client = deps.createClient(await deps.mintToken(repository.installationId, repository.name));
    prs =
      target.prs.length > 0 || target.headSha === undefined
        ? target.prs
        : await deps.policy.openPullRequestsAtHead(
            { repo: repository.fullName, client },
            target.headSha,
          );
  } catch (error) {
    deps.log.error('could not prepare the pr-policy evaluation', {
      ...context,
      error: describe(error),
    });
    return;
  }
  if (prs.length === 0) {
    deps.log.info('no open pull request to evaluate', context);
    return;
  }
  const checks = selectChecks(config.policy);
  for (const pr of [...new Set(prs)].sort((a, b) => a - b)) {
    const pullRequest = { repo: repository.fullName, pr, client };
    try {
      await evaluateOne(pullRequest, checks, config, { ...context, pr }, deps);
    } catch (error) {
      deps.log.error('pr-policy evaluation failed', { ...context, pr, error: describe(error) });
    }
  }
}

async function evaluateOne(
  target: PullRequestTarget & { client: GitHubClient },
  checks: readonly PolicyCheck[],
  config: PrPolicyConfig,
  context: LogFields,
  deps: PrPolicyDeps,
): Promise<void> {
  const live = config.mode === 'live';
  const { facts, headSha } = await deps.policy.gatherFacts(target);
  const title = config.policy.retitleDependabotCi ? ciRetitle(facts) : undefined;
  if (title !== undefined) {
    const retitled = live ? await setTitle(target, title) : true;
    if (retitled) {
      facts.title = title;
    } else {
      deps.log.warn('could not retitle the pull request', { ...context, title });
    }
  }
  const evaluation = await deps.policy.evaluatePolicy(facts, checks);
  if (live) {
    await deps.policy.applyLabelEdits(target, evaluation);
  }
  const name = verdictName(config);
  await deps.policy.postVerdict(target, headSha, evaluation, { name });
  const statuses = checkStatuses(checks, evaluation.findings);
  if (!(await deps.policy.postCheckStatuses(target, headSha, statuses, { context: name }))) {
    deps.log.warn('could not post the per-check statuses', context);
  }
  deps.log.info('evaluated', {
    ...context,
    mode: config.mode,
    name,
    outcome: evaluation.outcome,
    title: evaluation.title,
    retitle: title ?? null,
    checks: statuses.map(({ check, state }) => `${check}=${state}`),
  });
}

/** Sets the PR's title; false when GitHub refused. */
async function setTitle(
  target: PullRequestTarget & { client: GitHubClient },
  title: string,
): Promise<boolean> {
  const out = await target.client.send('PATCH', `repos/${target.repo}/pulls/${target.pr}`, {
    title,
  });
  return out !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
