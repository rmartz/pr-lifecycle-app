import { GitHubApiError } from '@rmartz/pr-lifecycle';
import { describe, expect, it } from 'vitest';
import type { EventTarget } from '../src/events.js';
import { runTarget } from '../src/run-target.js';
import { INSTALLATION_ID, makeDeps, REPO_ID, TEMPLATE_CONFIG } from './fixtures.js';

function makeTarget(overrides: Partial<EventTarget> = {}): EventTarget {
  return {
    repository: {
      installationId: INSTALLATION_ID,
      id: REPO_ID,
      owner: 'rmartz',
      name: 'firebase-nextjs-template',
      fullName: 'rmartz/firebase-nextjs-template',
    },
    prs: [31],
    headSha: undefined,
    ...overrides,
  };
}

describe('runTarget', () => {
  it("mints the token for the event's installation and repository only", async () => {
    const deps = makeDeps();
    await runTarget(makeTarget(), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.minted).toEqual([{ installationId: 777, repo: 'firebase-nextjs-template' }]);
  });

  it('builds the client from that token for that repository', async () => {
    const deps = makeDeps();
    await runTarget(makeTarget(), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.clients).toEqual([
      {
        token: 'token-for-777-firebase-nextjs-template',
        owner: 'rmartz',
        repo: 'firebase-nextjs-template',
      },
    ]);
  });

  it("reconciles with the repo's policy and dry-run setting", async () => {
    const deps = makeDeps();
    await runTarget(makeTarget(), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.reconciles.map(({ pr, policy, options }) => ({ pr, policy, options }))).toEqual([
      { pr: 31, policy: { uat: 'on', armAutoMerge: false }, options: { dryRun: true } },
    ]);
  });

  it('logs the result in the CLI --json shape', async () => {
    const deps = makeDeps();
    await runTarget(makeTarget(), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.log.entries[0]?.fields).toMatchObject({
      delivery: 'd-1',
      pr: 31,
      result: {
        repo: 'rmartz/firebase-nextjs-template',
        pr: 31,
        state: 'review-requested',
        dryRun: true,
      },
    });
  });

  it("looks up the head SHA's open PRs with the minted token when none are listed", async () => {
    const deps = makeDeps();
    await runTarget(makeTarget({ prs: [], headSha: 'abc123' }), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.lookups).toEqual([
      {
        token: 'token-for-777-firebase-nextjs-template',
        owner: 'rmartz',
        repo: 'firebase-nextjs-template',
        sha: 'abc123',
      },
    ]);
  });

  it('reconciles the PRs the lookup found', async () => {
    const deps = makeDeps();
    await runTarget(makeTarget({ prs: [], headSha: 'abc123' }), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.reconciles.map(({ pr }) => pr)).toEqual([51]);
  });

  it('logs and reconciles nothing when the lookup finds no open PR', async () => {
    const deps = makeDeps({ findOpenPulls: () => Promise.resolve([]) });
    await runTarget(makeTarget({ prs: [], headSha: 'abc123' }), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.log.entries.map(({ message }) => message)).toEqual([
      'no open pull request to reconcile',
    ]);
  });

  it('reconciles each PR once, in order, when a run lists duplicates', async () => {
    const deps = makeDeps();
    await runTarget(makeTarget({ prs: [40, 12, 40] }), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.reconciles.map(({ pr }) => pr)).toEqual([12, 40]);
  });

  it('logs a token failure and does not reconcile', async () => {
    const deps = makeDeps({ mintToken: () => Promise.reject(new Error('HTTP 404')) });
    await runTarget(makeTarget(), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.log.entries).toEqual([
      {
        level: 'error',
        message: 'could not prepare the reconcile',
        fields: { delivery: 'd-1', repo: 'rmartz/firebase-nextjs-template', error: 'HTTP 404' },
      },
    ]);
  });

  it('logs a transient failure as a warning and moves on to the next PR', async () => {
    const deps = makeDeps({
      reconcile: (_client, pr) =>
        pr === 1
          ? Promise.reject(new GitHubApiError(429, 'rate limited', { transient: true }))
          : Promise.reject(new Error('boom')),
    });
    await runTarget(makeTarget({ prs: [1, 2] }), TEMPLATE_CONFIG, 'd-1', deps);
    expect(deps.log.entries.map(({ level, fields }) => [level, fields['pr']])).toEqual([
      ['warn', 1],
      ['error', 2],
    ]);
  });
});
