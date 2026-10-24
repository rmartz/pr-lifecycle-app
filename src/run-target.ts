import type {
  GitHubClient,
  GitRunner,
  HttpClientOptions,
  ReconcileOptions,
  ReconcilePolicy,
  ReconcileResult,
} from '@rmartz/pr-lifecycle';
import { isTransientError, toReconcileJson } from '@rmartz/pr-lifecycle';
import type { EventRepository, EventTarget } from './events.js';
import type { MintToken } from './installation-token.js';
import type { LogFields, Logger } from './logger.js';
import type { FindOpenPulls } from './open-pulls.js';
import type { ActiveToolConfig } from './repos.js';
import type { SandboxGit } from './sandbox-git.js';

/** pr-lifecycle's settings for a repo it acts on. */
export type PrLifecycleConfig = ActiveToolConfig<ReconcilePolicy>;

/** The I/O a reconcile run needs, injected so it is testable without the network. */
export interface RunDeps {
  readonly mintToken: MintToken;
  readonly createClient: (options: HttpClientOptions) => GitHubClient;
  readonly findOpenPulls: FindOpenPulls;
  /** The git for approval carry-over, which fetches with `token`. One per run. */
  readonly createGit: (token: string) => SandboxGit;
  readonly reconcile: (
    client: GitHubClient,
    pr: number,
    policy: ReconcilePolicy,
    options: ReconcileOptions,
  ) => Promise<ReconcileResult>;
  readonly log: Logger;
}

/**
 * Reconciles every PR an event targets, with a token minted for the event's own
 * installation and repository. The App token is a real actor, so it serves both
 * reads and the release writes (arming, the sign-off status). Approval carry-over
 * runs git in one sandbox shared by the run's PRs, stopped when the run ends.
 * Never throws: a failure is logged, and the next event for the PR converges it.
 */
export async function runTarget(
  target: EventTarget,
  config: PrLifecycleConfig,
  deliveryId: string,
  deps: RunDeps,
): Promise<void> {
  const { repository } = target;
  const context = { delivery: deliveryId, repo: repository.fullName };
  let token: string;
  let prs: readonly number[];
  try {
    token = await deps.mintToken(repository.installationId, repository.name);
    prs =
      target.prs.length > 0 || target.headSha === undefined
        ? target.prs
        : await deps.findOpenPulls(token, repository.owner, repository.name, target.headSha);
  } catch (error) {
    deps.log.error('could not prepare the reconcile', { ...context, error: describe(error) });
    return;
  }
  if (prs.length === 0) {
    deps.log.info('no open pull request to reconcile', context);
    return;
  }
  const client = deps.createClient({ token, owner: repository.owner, repo: repository.name });
  const sandboxGit = deps.createGit(token);
  try {
    for (const pr of [...new Set(prs)].sort((a, b) => a - b)) {
      await reconcileOne(client, pr, repository, config, context, deps, sandboxGit.git);
    }
  } finally {
    const stopError = await sandboxGit.close();
    if (stopError !== undefined) {
      deps.log.warn('could not stop the git sandbox', { ...context, error: stopError });
    }
  }
}

async function reconcileOne(
  client: GitHubClient,
  pr: number,
  repository: EventRepository,
  config: PrLifecycleConfig,
  context: LogFields,
  deps: RunDeps,
  git: GitRunner,
): Promise<void> {
  try {
    // Shadow plans and logs without writing; only live writes.
    const dryRun = config.mode !== 'live';
    // No `lineage.token`: the sandbox's firewall authenticates git's fetches.
    const result = await deps.reconcile(client, pr, config.policy, { dryRun, lineage: { git } });
    const target = { owner: repository.owner, repo: repository.name, pr, dryRun };
    const json = toReconcileJson(target, result);
    deps.log.info('reconciled', { ...context, pr, result: json });
  } catch (error) {
    const fields = { ...context, pr, error: describe(error) };
    if (isTransientError(error)) {
      deps.log.warn('reconcile interrupted by a transient failure', fields);
    } else {
      deps.log.error('reconcile failed', fields);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
