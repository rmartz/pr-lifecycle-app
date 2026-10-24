import { describe, expect, it } from 'vitest';
import type { DecideOptions } from '../src/events.js';
import { decideEvent } from '../src/events.js';
import {
  BOT_LOGIN,
  INSTALLATION_ID,
  makeCheckSuiteEvent,
  makePullRef,
  makePullRequestEvent,
  makeRepository,
  makeReviewEvent,
  makeWorkflowRunEvent,
  REPO_ID,
} from './fixtures.js';

const OPTIONS: DecideOptions = {
  botLogin: BOT_LOGIN,
  isEnabled: (fullName) => fullName === 'rmartz/firebase-nextjs-template',
};

const REPOSITORY = {
  installationId: INSTALLATION_ID,
  id: REPO_ID,
  owner: 'rmartz',
  name: 'firebase-nextjs-template',
  fullName: 'rmartz/firebase-nextjs-template',
};

describe('decideEvent: pull_request', () => {
  it('reconciles the named PR under the payload installation', () => {
    expect(decideEvent('pull_request', makePullRequestEvent(), OPTIONS)).toEqual({
      kind: 'reconcile',
      target: { repository: REPOSITORY, prs: [31], headSha: undefined },
    });
  });

  it('ignores an action that cannot change the lifecycle state', () => {
    const event = makePullRequestEvent({ action: 'assigned' });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });

  it("skips a label written by the App's own bot", () => {
    const event = makePullRequestEvent({ action: 'labeled', sender: { login: BOT_LOGIN } });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'self-triggered',
    });
  });

  it("skips a review request made by the App's own bot, whatever its case", () => {
    const event = makePullRequestEvent({
      action: 'review_requested',
      sender: { login: 'RMARTZ-PR-LIFECYCLE[BOT]' },
    });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'self-triggered',
    });
  });

  it('still reconciles a label a person applied', () => {
    const event = makePullRequestEvent({ action: 'labeled', sender: { login: 'rmartz' } });
    expect(decideEvent('pull_request', event, OPTIONS)).toMatchObject({ kind: 'reconcile' });
  });

  it('still reconciles a push the bot made, since only label and review-request actions are self-skipped', () => {
    const event = makePullRequestEvent({ action: 'synchronize', sender: { login: BOT_LOGIN } });
    expect(decideEvent('pull_request', event, OPTIONS)).toMatchObject({ kind: 'reconcile' });
  });

  it('ignores a payload with no PR number', () => {
    const event = makePullRequestEvent({ pull_request: {} });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});

describe('decideEvent: pull_request_review', () => {
  it('reconciles the reviewed PR', () => {
    expect(decideEvent('pull_request_review', makeReviewEvent(), OPTIONS)).toEqual({
      kind: 'reconcile',
      target: { repository: REPOSITORY, prs: [32], headSha: undefined },
    });
  });

  it('ignores a review action outside submitted, dismissed and edited', () => {
    const event = makeReviewEvent({ action: 'requested' });
    expect(decideEvent('pull_request_review', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });
});

describe('decideEvent: check_suite', () => {
  it('reconciles the PRs the suite lists', () => {
    expect(decideEvent('check_suite', makeCheckSuiteEvent(), OPTIONS)).toEqual({
      kind: 'reconcile',
      target: { repository: REPOSITORY, prs: [33], headSha: undefined },
    });
  });

  it('drops a listed PR whose base is another repository', () => {
    const event = makeCheckSuiteEvent({ pull_requests: [makePullRef(33), makePullRef(90, 9999)] });
    expect(decideEvent('check_suite', event, OPTIONS)).toMatchObject({ target: { prs: [33] } });
  });

  it('falls back to the head SHA when the suite lists no PR (a fork PR)', () => {
    const event = makeCheckSuiteEvent({ pull_requests: [] });
    expect(decideEvent('check_suite', event, OPTIONS)).toEqual({
      kind: 'reconcile',
      target: { repository: REPOSITORY, prs: [], headSha: 'abc123' },
    });
  });

  it('ignores a suite that is not completed', () => {
    const event = makeCheckSuiteEvent({}, { action: 'requested' });
    expect(decideEvent('check_suite', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unhandled-action',
    });
  });

  it('ignores a suite with neither PRs nor a head SHA', () => {
    const event = makeCheckSuiteEvent({ pull_requests: [], head_sha: undefined });
    expect(decideEvent('check_suite', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });

  it('ignores a completed event with no suite object', () => {
    const event = makeCheckSuiteEvent({}, { check_suite: undefined });
    expect(decideEvent('check_suite', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});

describe('decideEvent: workflow_run', () => {
  it('reconciles the PRs the run lists', () => {
    expect(decideEvent('workflow_run', makeWorkflowRunEvent(), OPTIONS)).toEqual({
      kind: 'reconcile',
      target: { repository: REPOSITORY, prs: [34], headSha: undefined },
    });
  });

  it('falls back to the head SHA when the run lists no PR', () => {
    const event = makeWorkflowRunEvent({ pull_requests: [] });
    expect(decideEvent('workflow_run', event, OPTIONS)).toMatchObject({
      target: { prs: [], headSha: 'def456' },
    });
  });
});

describe('decideEvent: scoping', () => {
  it('ignores an event the App does not subscribe to', () => {
    expect(decideEvent('issues', makePullRequestEvent(), OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'unsubscribed-event',
    });
  });

  it('ignores an installed repository that is not enabled', () => {
    const event = makePullRequestEvent({
      repository: makeRepository({ full_name: 'rmartz/personal-budget', name: 'personal-budget' }),
    });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'repo-not-enabled',
    });
  });

  it('ignores a payload without an installation', () => {
    const event = makePullRequestEvent({ installation: undefined });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });

  it('ignores a payload whose installation id is not a positive integer', () => {
    const event = makePullRequestEvent({ installation: { id: '777' } });
    expect(decideEvent('pull_request', event, OPTIONS)).toEqual({
      kind: 'ignore',
      reason: 'malformed-payload',
    });
  });
});
