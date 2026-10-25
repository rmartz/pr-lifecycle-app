import type { EventRepository, EventTarget, IgnoreReason } from './events.js';
import { readRepository } from './events.js';
import { decideRerun } from './gate-events.js';

/** The one PR label merge-safety's verdict reads. */
const HOTFIX_LABEL = 'hotfix';
import type { Payload } from './payload.js';
import { idAt, objectAt, stringAt } from './payload.js';

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
      /**
       * For a base CI run, the commit it ran on: the fan-out happens only while
       * that commit is still the branch tip, so a stale or redelivered run costs
       * one read, not a fan-out. Undefined for a push, which is the tip.
       */
      readonly tipSha: string | undefined;
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
  if (!changesVerdictInput(action, payload)) {
    return ignore('unhandled-action');
  }
  const pr = idAt(objectAt(payload, 'pull_request'), 'number');
  return pr === undefined
    ? ignore('malformed-payload')
    : { kind: 'evaluate', target: { repository, prs: [pr], headSha: undefined } };
}

/**
 * Whether a PR event touches anything merge-safety reads. Of the PR's labels it
 * reads only `hotfix` (its own two it writes, never reads), and of an edit only
 * the title (a `!` or a `docs` type). The actor App writes several lifecycle
 * labels per PR change; evaluating on each would spend the budget on verdicts
 * that can't differ.
 */
function changesVerdictInput(action: string, payload: Payload): boolean {
  switch (action) {
    case 'labeled':
    case 'unlabeled':
      return stringAt(objectAt(payload, 'label'), 'name')?.toLowerCase() === HOTFIX_LABEL;
    case 'edited':
      return objectAt(objectAt(payload, 'changes'), 'title') !== undefined;
    default:
      return true;
  }
}

/** A push to a branch invalidates its PRs; a tag push or a deletion does nothing. */
function decidePush(payload: Payload, repository: EventRepository): MergeSafetyDecision {
  const ref = stringAt(payload, 'ref');
  if (ref === undefined || !ref.startsWith('refs/heads/') || payload['deleted'] === true) {
    return ignore('unhandled-action');
  }
  return {
    kind: 'invalidate',
    repository,
    baseBranch: ref.slice('refs/heads/'.length),
    tipSha: undefined,
  };
}

/**
 * The default branch's CI completing can flip base health, so its PRs
 * re-evaluate. Only a run a push started counts as the base's CI. A workflow
 * started by any other event (`status`, `workflow_dispatch`, a schedule) also
 * reports the default branch as its head branch, and following those would loop:
 * the gate's own pending statuses start `status` workflows, whose completions
 * would invalidate again.
 */
function decideWorkflowRun(payload: Payload, repository: EventRepository): MergeSafetyDecision {
  if (stringAt(payload, 'action') !== 'completed') {
    return ignore('unhandled-action');
  }
  const run = objectAt(payload, 'workflow_run');
  const branch = stringAt(run, 'head_branch');
  const defaultBranch = stringAt(objectAt(payload, 'repository'), 'default_branch');
  if (branch === undefined || branch !== defaultBranch || stringAt(run, 'event') !== 'push') {
    return ignore('unhandled-action');
  }
  const tipSha = stringAt(run, 'head_sha');
  return tipSha === undefined
    ? ignore('malformed-payload')
    : { kind: 'invalidate', repository, baseBranch: branch, tipSha };
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
      return decideRerun(payload, repository, options.checkNames);
  }
}
