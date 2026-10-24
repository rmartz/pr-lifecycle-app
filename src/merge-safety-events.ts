import type { EventRepository, EventTarget, IgnoreReason } from './events.js';
import { readRepository } from './events.js';
import type { Payload } from './payload.js';
import { idAt, objectAt, objectsAt, stringAt } from './payload.js';

/**
 * Deciding what a gate delivery means for merge-safety. Pure. It mirrors the
 * triggers of merge-safety's caller workflow:
 * - a PR change evaluates that PR;
 * - a push to a branch, or the default branch's CI completing, invalidates every
 *   open PR based on that branch (they are re-evaluated in place);
 * - a Re-run of the gate's own check-run re-evaluates its PR, replacing the
 *   workflow's `workflow_dispatch`.
 */

export const MERGE_SAFETY_EVENTS = ['pull_request', 'push', 'workflow_run', 'check_run'] as const;
type MergeSafetyEvent = (typeof MERGE_SAFETY_EVENTS)[number];

/** The pull_request actions that can change the verdict. */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'synchronize',
  'reopened',
  'edited',
  'labeled',
  'unlabeled',
]);

/** The actions the gate's own label (and retitle) writes cause; skipped when it sent them. */
const SELF_TRIGGERED_ACTIONS: ReadonlySet<string> = new Set(['labeled', 'unlabeled', 'edited']);

export type MergeSafetyDecision =
  | { readonly kind: 'ignore'; readonly reason: IgnoreReason }
  | { readonly kind: 'evaluate'; readonly target: EventTarget }
  | {
      readonly kind: 'invalidate';
      readonly repository: EventRepository;
      /** The branch that moved; its open PRs are re-evaluated. */
      readonly baseBranch: string;
    };

export interface MergeSafetyDecideOptions {
  /** The gate App's bot login, e.g. `rmartz-pr-gate[bot]`. */
  readonly botLogin: string;
  /** The check-run names the gate posts merge-safety under (real and shadow). */
  readonly checkNames: readonly string[];
  /** Whether merge-safety acts on this `owner/name`. */
  readonly isEnabled: (fullName: string) => boolean;
}

function ignore(reason: IgnoreReason): MergeSafetyDecision {
  return { kind: 'ignore', reason };
}

function isMergeSafetyEvent(name: string): name is MergeSafetyEvent {
  return (MERGE_SAFETY_EVENTS as readonly string[]).includes(name);
}

function decidePullRequest(
  payload: Payload,
  repository: EventRepository,
  botLogin: string,
): MergeSafetyDecision {
  const action = stringAt(payload, 'action');
  if (action === undefined || !PULL_REQUEST_ACTIONS.has(action)) {
    return ignore('unhandled-action');
  }
  const sender = stringAt(objectAt(payload, 'sender'), 'login');
  if (SELF_TRIGGERED_ACTIONS.has(action) && sender?.toLowerCase() === botLogin.toLowerCase()) {
    return ignore('self-triggered');
  }
  const pr = idAt(objectAt(payload, 'pull_request'), 'number');
  return pr === undefined
    ? ignore('malformed-payload')
    : { kind: 'evaluate', target: { repository, prs: [pr], headSha: undefined } };
}

/** A push to a branch invalidates its PRs; a tag push or a deletion does nothing. */
function decidePush(payload: Payload, repository: EventRepository): MergeSafetyDecision {
  const ref = stringAt(payload, 'ref');
  if (ref === undefined || !ref.startsWith('refs/heads/') || payload['deleted'] === true) {
    return ignore('unhandled-action');
  }
  return { kind: 'invalidate', repository, baseBranch: ref.slice('refs/heads/'.length) };
}

/** The default branch's CI completing can flip base health, so its PRs re-evaluate. */
function decideWorkflowRun(payload: Payload, repository: EventRepository): MergeSafetyDecision {
  if (stringAt(payload, 'action') !== 'completed') {
    return ignore('unhandled-action');
  }
  const branch = stringAt(objectAt(payload, 'workflow_run'), 'head_branch');
  const defaultBranch = stringAt(objectAt(payload, 'repository'), 'default_branch');
  if (branch === undefined || branch !== defaultBranch) {
    return ignore('unhandled-action');
  }
  return { kind: 'invalidate', repository, baseBranch: branch };
}

/** A Re-run of the gate's own merge-safety check-run re-evaluates its PRs. */
function decideCheckRun(
  payload: Payload,
  repository: EventRepository,
  checkNames: readonly string[],
): MergeSafetyDecision {
  if (stringAt(payload, 'action') !== 'rerequested') {
    return ignore('unhandled-action');
  }
  const run = objectAt(payload, 'check_run');
  const name = stringAt(run, 'name');
  if (name === undefined || !checkNames.includes(name)) {
    return ignore('unhandled-action');
  }
  const prs = objectsAt(run, 'pull_requests')
    .filter((pull) => idAt(objectAt(objectAt(pull, 'base'), 'repo'), 'id') === repository.id)
    .map((pull) => idAt(pull, 'number'))
    .filter((pr) => pr !== undefined);
  const headSha = prs.length === 0 ? stringAt(run, 'head_sha') : undefined;
  if (prs.length === 0 && headSha === undefined) {
    return ignore('malformed-payload');
  }
  return { kind: 'evaluate', target: { repository, prs, headSha } };
}

/** Decides what one gate delivery should do for merge-safety, if anything. */
export function decideMergeSafetyEvent(
  eventName: string,
  payload: Payload,
  options: MergeSafetyDecideOptions,
): MergeSafetyDecision {
  if (!isMergeSafetyEvent(eventName)) {
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
    case 'pull_request':
      return decidePullRequest(payload, repository, options.botLogin);
    case 'push':
      return decidePush(payload, repository);
    case 'workflow_run':
      return decideWorkflowRun(payload, repository);
    case 'check_run':
      return decideCheckRun(payload, repository, options.checkNames);
  }
}
