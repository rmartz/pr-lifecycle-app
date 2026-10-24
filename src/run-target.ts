import type {
  GitHubClient,
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
import type { RepoConfig } from './repos.js';

/** The I/O a reconcile run needs, injected so it is testable without the network. */
export interface RunDeps {
  readonly mintToken: MintToken;
  readonly createClient: (options: HttpClientOptions) => GitHubClient;
  readonly findOpenPulls: FindOpenPulls;
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
 * reads and the release writes (arming, the sign-off status); carry-over is off,
 * as no git is available (it fails closed). Never throws: a failure is logged,
 * and the next event for the PR converges it.
 */
export async function runTarget(
  target: EventTarget,
  config: RepoConfig,
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
  for (const pr of [...new Set(prs)].sort((a, b) => a - b)) {
    await reconcileOne(client, pr, repository, config, context, deps);
  }
}

async function reconcileOne(
  client: GitHubClient,
  pr: number,
  repository: EventRepository,
  config: RepoConfig,
  context: LogFields,
  deps: RunDeps,
): Promise<void> {
  try {
    const result = await deps.reconcile(client, pr, config.policy, { dryRun: config.dryRun });
    const target = { owner: repository.owner, repo: repository.name, pr, dryRun: config.dryRun };
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
