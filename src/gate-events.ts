import type { EventRepository, EventTarget, IgnoreReason } from './events.js';
import { readRepository } from './events.js';
import type { Payload } from './payload.js';
import { idAt, objectAt, objectsAt, stringAt } from './payload.js';

/**
 * Deciding which PRs a gate delivery re-evaluates with pr-policy. Pure, like the
 * actor's `decideEvent`, and mirrors the triggers of pr-policy's caller
 * workflow: the PR's own changes, plus pr-lifecycle's sign-off status. A Re-run
 * of the gate's own pr-policy check-run re-evaluates too.
 */

/** The events the gate's pr-policy route reads; anything else is ignored. */
export const PR_POLICY_EVENTS = ['pull_request', 'status', 'check_run'] as const;
type PrPolicyEvent = (typeof PR_POLICY_EVENTS)[number];

/** The pull_request actions that change what pr-policy judges. */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'synchronize',
  'reopened',
  'edited',
  'labeled',
  'unlabeled',
]);

/**
 * The actions the gate's own writes cause: its `CI approval needed` label and
 * the Dependabot `ci` retitle. Skipped when the gate sent them, so its writes
 * don't re-trigger it; the same action from anyone else (a person, or the actor
 * App writing a lifecycle label) still re-evaluates.
 */
const SELF_TRIGGERED_ACTIONS: ReadonlySet<string> = new Set(['labeled', 'unlabeled', 'edited']);

/** The commit status that re-evaluates the PRs at its commit. */
export const SIGN_OFF_STATUS_CONTEXT = 'pr-lifecycle/sign-off';

export type GateDecision =
  | { readonly kind: 'ignore'; readonly reason: IgnoreReason }
  | { readonly kind: 'evaluate'; readonly target: EventTarget };

export interface GateDecideOptions {
  /** The gate App's bot login, e.g. `rmartz-pr-gate[bot]`. */
  readonly botLogin: string;
  /** The check-run names the gate posts pr-policy under (real and shadow). */
  readonly checkNames: readonly string[];
  /** Whether pr-policy acts on this `owner/name`. */
  readonly isEnabled: (fullName: string) => boolean;
}

function ignore(reason: IgnoreReason): GateDecision {
  return { kind: 'ignore', reason };
}

function isPrPolicyEvent(name: string): name is PrPolicyEvent {
  return (PR_POLICY_EVENTS as readonly string[]).includes(name);
}

function decidePullRequest(payload: Payload, botLogin: string): GateDecision | number {
  const action = stringAt(payload, 'action');
  if (action === undefined || !PULL_REQUEST_ACTIONS.has(action)) {
    return ignore('unhandled-action');
  }
  const sender = stringAt(objectAt(payload, 'sender'), 'login');
  if (SELF_TRIGGERED_ACTIONS.has(action) && sender?.toLowerCase() === botLogin.toLowerCase()) {
    return ignore('self-triggered');
  }
  return idAt(objectAt(payload, 'pull_request'), 'number') ?? ignore('malformed-payload');
}

/**
 * The target of a Re-run (`check_run` `rerequested`) of one of the gate's own
 * check-runs: the PRs into this repository it lists, or else its head SHA. Any
 * other check-run action or name is ignored, so the gate's own check-run
 * writes (`created`, `completed`) never re-trigger it. Shared by both gate tools.
 */
export function decideRerun(
  payload: Payload,
  repository: EventRepository,
  checkNames: readonly string[],
):
  | { readonly kind: 'ignore'; readonly reason: IgnoreReason }
  | { readonly kind: 'evaluate'; readonly target: EventTarget } {
  if (stringAt(payload, 'action') !== 'rerequested') {
    return { kind: 'ignore', reason: 'unhandled-action' };
  }
  const run = objectAt(payload, 'check_run');
  const name = stringAt(run, 'name');
  if (name === undefined || !checkNames.includes(name)) {
    return { kind: 'ignore', reason: 'unhandled-action' };
  }
  const prs = objectsAt(run, 'pull_requests')
    .filter((pull) => idAt(objectAt(objectAt(pull, 'base'), 'repo'), 'id') === repository.id)
    .map((pull) => idAt(pull, 'number'))
    .filter((pr) => pr !== undefined);
  const headSha = prs.length === 0 ? stringAt(run, 'head_sha') : undefined;
  if (prs.length === 0 && headSha === undefined) {
    return { kind: 'ignore', reason: 'malformed-payload' };
  }
  return { kind: 'evaluate', target: { repository, prs, headSha } };
}

/**
 * Decides what one gate delivery should evaluate, if anything. A `status` event
 * names a commit, not a PR, so its target carries the SHA and the open PRs at
 * it are looked up; any status other than pr-lifecycle's sign-off (the gate's
 * own included) is ignored.
 */
export function decideGateEvent(
  eventName: string,
  payload: Payload,
  options: GateDecideOptions,
): GateDecision {
  if (!isPrPolicyEvent(eventName)) {
    return ignore('unsubscribed-event');
  }
  const repository = readRepository(payload);
  if (repository === undefined) {
    return ignore('malformed-payload');
  }
  if (!options.isEnabled(repository.fullName)) {
    return ignore('repo-not-enabled');
  }
  switch (eventName) {
    case 'pull_request': {
      const pr = decidePullRequest(payload, options.botLogin);
      return typeof pr === 'number'
        ? { kind: 'evaluate', target: { repository, prs: [pr], headSha: undefined } }
        : pr;
    }
    case 'status': {
      if (stringAt(payload, 'context') !== SIGN_OFF_STATUS_CONTEXT) {
        return ignore('unhandled-action');
      }
      const sha = stringAt(payload, 'sha');
      return sha === undefined
        ? ignore('malformed-payload')
        : { kind: 'evaluate', target: { repository, prs: [], headSha: sha } };
    }
    case 'check_run':
      return decideRerun(payload, repository, options.checkNames);
  }
}
