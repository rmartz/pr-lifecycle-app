import { describe, expect, it } from 'vitest';
import type { GateDecideOptions } from '../src/gate-events.js';
import { decideGateEvent } from '../src/gate-events.js';
import {
  INSTALLATION_ID,
  makeCheckSuiteEvent,
  makePullRef,
  makePullRequestEvent,
  makeRepository,
} from './fixtures.js';
import { GATE_BOT, makeStatusEvent } from './gate-fixtures.js';

const OPTIONS: GateDecideOptions = {
  botLogin: GATE_BOT,
  checkNames: ['pr-policy', 'pr-policy (app)'],
  isEnabled: (fullName) => fullName === 'rmartz/firebase-nextjs-template',
};

describe('decideGateEvent: pull_request', () => {
  it.each(['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'unlabeled'])(
    'evaluates the PR on %s',
    (action) => {
      const decision = decideGateEvent('pull_request', makePullRequestEvent({ action }), OPTIONS);
      expect(decision).toMatchObject({ kind: 'evaluate', target: { prs: [31] } });
    },
  );

  it('ignores an action that cannot change the verdict', () => {
    const event = makePullRequestEvent({ action: 'review_requested' });
    expect(decideGateEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });

  it.each(['labeled', 'unlabeled', 'edited'])("skips the gate's own %s write", (action) => {
    const event = makePullRequestEvent({ action, sender: { login: GATE_BOT } });
    expect(decideGateEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'self-triggered',
    });
  });

  it("still evaluates the actor App's label write", () => {
    const event = makePullRequestEvent({
      action: 'labeled',
      sender: { login: 'rmartz-pr-lifecycle[bot]' },
    });
    expect(decideGateEvent('pull_request', event, OPTIONS).kind).toBe('evaluate');
  });

  it("evaluates the gate's own synchronize, which its writes can't cause", () => {
    const event = makePullRequestEvent({ action: 'synchronize', sender: { login: GATE_BOT } });
    expect(decideGateEvent('pull_request', event, OPTIONS).kind).toBe('evaluate');
  });

  it('rejects a pull_request with no PR number as malformed', () => {
    const event = makePullRequestEvent({ pull_request: {} });
    expect(decideGateEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});

describe('decideGateEvent: status', () => {
  it("re-evaluates the open PRs at the sign-off status's commit", () => {
    expect(decideGateEvent('status', makeStatusEvent(), OPTIONS)).toMatchObject({
      kind: 'evaluate',
      target: { prs: [], headSha: 'abc123' },
    });
  });

  it("ignores any other status, the gate's own pr-policy included", () => {
    const event = makeStatusEvent({ context: 'pr-policy (app)', sender: { login: GATE_BOT } });
    expect(decideGateEvent('status', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });

  it('rejects a sign-off status with no commit as malformed', () => {
    const event = makeStatusEvent({ sha: undefined });
    expect(decideGateEvent('status', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});

describe('decideGateEvent: scope', () => {
  it("ignores an event the pr-policy route doesn't read", () => {
    expect(decideGateEvent('check_suite', makeCheckSuiteEvent(), OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unsubscribed-event',
    });
  });

  it('ignores a repo where pr-policy is not enabled', () => {
    const event = makePullRequestEvent({
      repository: makeRepository({ full_name: 'rmartz/personal-budget', name: 'personal-budget' }),
    });
    expect(decideGateEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'repo-not-enabled',
    });
  });

  it('rejects a delivery with no installation as malformed', () => {
    const event = makePullRequestEvent({ installation: undefined });
    expect(decideGateEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });

  it('carries the installation and repository from the payload', () => {
    expect(decideGateEvent('pull_request', makePullRequestEvent(), OPTIONS)).toMatchObject({
      target: {
        repository: { installationId: 777, fullName: 'rmartz/firebase-nextjs-template' },
      },
    });
  });
});

describe('decideGateEvent: Re-run', () => {
  const makeRerun = (run = {}, overrides = {}) => ({
    installation: { id: INSTALLATION_ID },
    repository: makeRepository(),
    sender: { login: 'rmartz' },
    action: 'rerequested',
    check_run: {
      name: 'pr-policy (app)',
      head_sha: 'abc123',
      pull_requests: [makePullRef(37)],
      ...run,
    },
    ...overrides,
  });

  it("re-evaluates the PRs a Re-run of the gate's pr-policy check names", () => {
    expect(decideGateEvent('check_run', makeRerun(), OPTIONS)).toMatchObject({
      kind: 'evaluate',
      target: { prs: [37] },
    });
  });

  it("ignores a Re-run of merge-safety's check", () => {
    const event = makeRerun({ name: 'merge-safety (app)' });
    expect(decideGateEvent('check_run', event, OPTIONS).kind).toBe('ignore');
  });

  it("ignores the gate's own check-run being created", () => {
    const event = makeRerun({}, { action: 'created' });
    expect(decideGateEvent('check_run', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });
});
