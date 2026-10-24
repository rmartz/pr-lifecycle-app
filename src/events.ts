import type { Payload } from './payload.js';
import { idAt, objectAt, objectsAt, stringAt } from './payload.js';

/**
 * Deciding what a webhook delivery means: whether to act on it at all, and which
 * PR(s) of which repository, under which installation. Pure: a function of the
 * event name and payload, ported from the action's `resolve_prs`
 * (rmartz/pr-lifecycle-action scripts/reconcile.sh) so both reconcile the same PRs.
 */

/** The events the App subscribes to; anything else is acknowledged and ignored. */
export const SUBSCRIBED_EVENTS = [
  'pull_request',
  'pull_request_review',
  'check_suite',
  'workflow_run',
] as const;
export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

/** The pull_request actions that can change a PR's lifecycle state (the action's triggers). */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'reopened',
  'ready_for_review',
  'converted_to_draft',
  'synchronize',
  'edited',
  'labeled',
  'unlabeled',
  'review_requested',
  'review_request_removed',
]);

/**
 * The pull_request actions the App's own writes cause (its label and
 * review-request writes). Skipped when the App sent them, so its writes don't
 * re-trigger it; the same action from a person still reconciles.
 */
const SELF_TRIGGERED_ACTIONS: ReadonlySet<string> = new Set([
  'labeled',
  'unlabeled',
  'review_requested',
  'review_request_removed',
]);

const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['submitted', 'dismissed', 'edited']);

export type IgnoreReason =
  | 'unsubscribed-event'
  | 'unhandled-action'
  | 'malformed-payload'
  | 'repo-not-enabled'
  | 'self-triggered';

/** The repository and installation an event belongs to, from the payload. */
export interface EventRepository {
  readonly installationId: number;
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

/**
 * What to reconcile. `prs` lists the PRs the payload names; when it is empty,
 * `headSha` is the CI run's head commit, whose open PRs must be looked up (GitHub
 * leaves `pull_requests` empty for fork PRs).
 */
export interface EventTarget {
  readonly repository: EventRepository;
  readonly prs: readonly number[];
  readonly headSha: string | undefined;
}

export type EventDecision =
  | { readonly kind: 'ignore'; readonly reason: IgnoreReason }
  | { readonly kind: 'reconcile'; readonly target: EventTarget };

export interface DecideOptions {
  /** The App's bot login, e.g. `rmartz-pr-lifecycle[bot]`. */
  readonly botLogin: string;
  /** Whether the App acts on this `owner/name`. */
  readonly isEnabled: (fullName: string) => boolean;
}

function ignore(reason: IgnoreReason): EventDecision {
  return { kind: 'ignore', reason };
}

function isSubscribed(name: string): name is SubscribedEvent {
  return (SUBSCRIBED_EVENTS as readonly string[]).includes(name);
}

function readRepository(payload: Payload): EventRepository | undefined {
  const installationId = idAt(objectAt(payload, 'installation'), 'id');
  const repo = objectAt(payload, 'repository');
  const id = idAt(repo, 'id');
  const name = stringAt(repo, 'name');
  const owner = stringAt(objectAt(repo, 'owner'), 'login');
  const fullName = stringAt(repo, 'full_name');
  if (
    installationId === undefined ||
    id === undefined ||
    name === undefined ||
    owner === undefined ||
    fullName === undefined
  ) {
    return undefined;
  }
  return { installationId, id, owner, name, fullName };
}

/** The PR a pull_request or pull_request_review event names. */
function namedPullRequest(payload: Payload): number | undefined {
  return idAt(objectAt(payload, 'pull_request'), 'number');
}

/** The PRs a CI run lists, keeping only those into this repository (not a fork's base). */
function listedPullRequests(run: Payload, repoId: number): number[] {
  return objectsAt(run, 'pull_requests')
    .filter((pull) => idAt(objectAt(objectAt(pull, 'base'), 'repo'), 'id') === repoId)
    .map((pull) => idAt(pull, 'number'))
    .filter((pr) => pr !== undefined);
}

function decideCiRun(
  run: Payload | undefined,
  action: string | undefined,
  repository: EventRepository,
): EventDecision {
  if (action !== 'completed') {
    return ignore('unhandled-action');
  }
  if (run === undefined) {
    return ignore('malformed-payload');
  }
  const prs = listedPullRequests(run, repository.id);
  const headSha = prs.length === 0 ? stringAt(run, 'head_sha') : undefined;
  if (prs.length === 0 && headSha === undefined) {
    return ignore('malformed-payload');
  }
  return { kind: 'reconcile', target: { repository, prs, headSha } };
}

function decidePullRequestEvent(
  payload: Payload,
  actions: ReadonlySet<string>,
  repository: EventRepository,
  botLogin: string,
): EventDecision {
  const action = stringAt(payload, 'action');
  if (action === undefined || !actions.has(action)) {
    return ignore('unhandled-action');
  }
  const sender = stringAt(objectAt(payload, 'sender'), 'login');
  if (SELF_TRIGGERED_ACTIONS.has(action) && sender?.toLowerCase() === botLogin.toLowerCase()) {
    return ignore('self-triggered');
  }
  const pr = namedPullRequest(payload);
  if (pr === undefined) {
    return ignore('malformed-payload');
  }
  return { kind: 'reconcile', target: { repository, prs: [pr], headSha: undefined } };
}

/** Decides what one webhook delivery should reconcile, if anything. */
export function decideEvent(
  eventName: string,
  payload: Payload,
  options: DecideOptions,
): EventDecision {
  if (!isSubscribed(eventName)) {
    return ignore('unsubscribed-event');
  }
  const repository = readRepository(payload);
  if (repository === undefined) {
    return ignore('malformed-payload');
  }
  if (!options.isEnabled(repository.fullName)) {
    return ignore('repo-not-enabled');
  }
  const action = stringAt(payload, 'action');
  switch (eventName) {
    case 'pull_request':
      return decidePullRequestEvent(payload, PULL_REQUEST_ACTIONS, repository, options.botLogin);
    case 'pull_request_review':
      return decidePullRequestEvent(payload, REVIEW_ACTIONS, repository, options.botLogin);
    case 'check_suite':
      return decideCiRun(objectAt(payload, 'check_suite'), action, repository);
    case 'workflow_run':
      return decideCiRun(objectAt(payload, 'workflow_run'), action, repository);
  }
}
