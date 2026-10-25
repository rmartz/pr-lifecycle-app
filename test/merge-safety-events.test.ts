import { describe, expect, it } from 'vitest';
import type { MergeSafetyDecideOptions } from '../src/merge-safety-events.js';
import { decideMergeSafetyEvent } from '../src/merge-safety-events.js';
import type { Payload } from '../src/payload.js';
import {
  INSTALLATION_ID,
  makePullRef,
  makePullRequestEvent,
  makeRepository,
  makeWorkflowRunEvent,
  REPO_ID,
} from './fixtures.js';
import { GATE_BOT, makeStatusEvent } from './gate-fixtures.js';

const OPTIONS: MergeSafetyDecideOptions = {
  botLogin: GATE_BOT,
  checkNames: ['merge-safety', 'merge-safety (app)'],
  isEnabled: (fullName) => fullName === 'rmartz/firebase-nextjs-template',
};

function makePushEvent(overrides: Payload = {}): Payload {
  return {
    installation: { id: INSTALLATION_ID },
    repository: makeRepository({ default_branch: 'main' }),
    sender: { login: 'rmartz' },
    ref: 'refs/heads/main',
    deleted: false,
    ...overrides,
  };
}

function makeCheckRunEvent(run: Payload = {}, overrides: Payload = {}): Payload {
  return {
    installation: { id: INSTALLATION_ID },
    repository: makeRepository(),
    sender: { login: 'rmartz' },
    action: 'rerequested',
    check_run: {
      name: 'merge-safety (app)',
      head_sha: 'abc123',
      pull_requests: [makePullRef(35)],
      ...run,
    },
    ...overrides,
  };
}

describe('decideMergeSafetyEvent: pull_request', () => {
  it.each(['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'unlabeled'])(
    'evaluates the PR on %s',
    (action) => {
      expect(
        decideMergeSafetyEvent('pull_request', makePullRequestEvent({ action }), OPTIONS),
      ).toMatchObject({ kind: 'evaluate', target: { prs: [31] } });
    },
  );

  it("skips the gate's own label write", () => {
    const event = makePullRequestEvent({ action: 'unlabeled', sender: { login: GATE_BOT } });
    expect(decideMergeSafetyEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'self-triggered',
    });
  });

  it('ignores an action that cannot change the verdict', () => {
    const event = makePullRequestEvent({ action: 'closed' });
    expect(decideMergeSafetyEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });
});

describe('decideMergeSafetyEvent: base moves', () => {
  it('invalidates the PRs on a pushed branch', () => {
    expect(decideMergeSafetyEvent('push', makePushEvent(), OPTIONS)).toMatchObject({
      kind: 'invalidate',
      baseBranch: 'main',
      tipSha: undefined,
      repository: { fullName: 'rmartz/firebase-nextjs-template' },
    });
  });

  it('invalidates a stacked parent branch too, not just the default', () => {
    const event = makePushEvent({ ref: 'refs/heads/feature/big' });
    expect(decideMergeSafetyEvent('push', event, OPTIONS)).toMatchObject({
      baseBranch: 'feature/big',
    });
  });

  it('ignores a tag push', () => {
    const event = makePushEvent({ ref: 'refs/tags/v1.0.0' });
    expect(decideMergeSafetyEvent('push', event, OPTIONS).kind).toBe('ignore');
  });

  it('ignores a branch deletion', () => {
    const event = makePushEvent({ deleted: true });
    expect(decideMergeSafetyEvent('push', event, OPTIONS).kind).toBe('ignore');
  });

  it("invalidates the default branch's PRs when its CI completes", () => {
    const event = makeWorkflowRunEvent(
      { head_branch: 'main', event: 'push', head_sha: 'tip9' },
      { repository: makeRepository({ default_branch: 'main' }) },
    );
    expect(decideMergeSafetyEvent('workflow_run', event, OPTIONS)).toMatchObject({
      kind: 'invalidate',
      baseBranch: 'main',
      tipSha: 'tip9',
    });
  });

  it("ignores a default-branch run a status started, which would loop on the gate's own statuses", () => {
    const event = makeWorkflowRunEvent(
      { head_branch: 'main', event: 'status' },
      { repository: makeRepository({ default_branch: 'main' }) },
    );
    expect(decideMergeSafetyEvent('workflow_run', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });

  it('rejects a base CI run with no head commit as malformed', () => {
    const event = makeWorkflowRunEvent(
      { head_branch: 'main', event: 'push', head_sha: undefined },
      { repository: makeRepository({ default_branch: 'main' }) },
    );
    expect(decideMergeSafetyEvent('workflow_run', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });

  it('ignores CI completing on a PR branch', () => {
    const event = makeWorkflowRunEvent(
      { head_branch: 'feature/x', event: 'push' },
      { repository: makeRepository({ default_branch: 'main' }) },
    );
    expect(decideMergeSafetyEvent('workflow_run', event, OPTIONS).kind).toBe('ignore');
  });

  it('ignores a CI run that has not completed', () => {
    const event = makeWorkflowRunEvent(
      { head_branch: 'main', event: 'push' },
      { action: 'requested', repository: makeRepository({ default_branch: 'main' }) },
    );
    expect(decideMergeSafetyEvent('workflow_run', event, OPTIONS).kind).toBe('ignore');
  });
});

describe('decideMergeSafetyEvent: Re-run', () => {
  it("re-evaluates the PRs a Re-run of the gate's check names", () => {
    expect(decideMergeSafetyEvent('check_run', makeCheckRunEvent(), OPTIONS)).toMatchObject({
      kind: 'evaluate',
      target: { prs: [35], headSha: undefined },
    });
  });

  it('falls back to the head SHA when the run lists no PR into this repo', () => {
    const event = makeCheckRunEvent({ pull_requests: [makePullRef(36, REPO_ID + 1)] });
    expect(decideMergeSafetyEvent('check_run', event, OPTIONS)).toMatchObject({
      target: { prs: [], headSha: 'abc123' },
    });
  });

  it("ignores a Re-run of another check's run", () => {
    const event = makeCheckRunEvent({ name: 'Lint' });
    expect(decideMergeSafetyEvent('check_run', event, OPTIONS).kind).toBe('ignore');
  });

  it('ignores a check-run that was not re-requested', () => {
    const event = makeCheckRunEvent({}, { action: 'completed' });
    expect(decideMergeSafetyEvent('check_run', event, OPTIONS).kind).toBe('ignore');
  });

  it('rejects a Re-run with neither a PR nor a head SHA as malformed', () => {
    const event = makeCheckRunEvent({ pull_requests: [], head_sha: undefined });
    expect(decideMergeSafetyEvent('check_run', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});

describe('decideMergeSafetyEvent: scope', () => {
  it("ignores an event merge-safety doesn't read", () => {
    expect(decideMergeSafetyEvent('status', makeStatusEvent(), OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unsubscribed-event',
    });
  });

  it('ignores a repo where merge-safety is not enabled', () => {
    const event = makePushEvent({
      repository: makeRepository({ full_name: 'rmartz/personal-budget', name: 'personal-budget' }),
    });
    expect(decideMergeSafetyEvent('push', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'repo-not-enabled',
    });
  });

  it('rejects a delivery with no repository as malformed', () => {
    expect(
      decideMergeSafetyEvent('push', makePushEvent({ repository: undefined }), OPTIONS),
    ).toEqual({ kind: 'ignore', reason: 'malformed-payload' });
  });
});
