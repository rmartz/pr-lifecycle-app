import { describe, expect, it } from 'vitest';
import {
  baseChecksProbe,
  openPullsOnBase,
  postCheck,
  readPr,
  requiredChecksProbe,
} from '../src/merge-safety-io.js';
import { makeFakeClient } from './fake-client.js';
import { makePull, REPO } from './merge-safety-fixtures.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const noSleep = () => Promise.resolve();
const RUNS = `repos/${REPO}/commits/head1/check-runs?check_name=merge-safety&filter=all`;

describe('readPr', () => {
  it('maps a mergeable PR to the meta merge-safety reads', async () => {
    const client = makeFakeClient({ [`repos/${REPO}/pulls/31`]: makePull() });
    expect(await readPr(client, REPO, 31, noSleep)).toEqual({
      state: 'OPEN',
      baseBranch: 'main',
      meta: {
        headSha: 'head1',
        title: 'feat: add a thing',
        labels: ['no UAT needed'],
        mergeable: 'MERGEABLE',
      },
    });
  });

  it('reads a conflicting PR as CONFLICTING', async () => {
    const client = makeFakeClient({ [`repos/${REPO}/pulls/31`]: makePull({ mergeable: false }) });
    expect((await readPr(client, REPO, 31, noSleep))?.meta.mergeable).toBe('CONFLICTING');
  });

  it('passes a still-unknown mergeability on as UNKNOWN after the last read', async () => {
    const client = makeFakeClient({ [`repos/${REPO}/pulls/31`]: makePull({ mergeable: null }) });
    expect((await readPr(client, REPO, 31, noSleep, 2))?.meta.mergeable).toBe('UNKNOWN');
  });

  it('reads a merged PR as MERGED', async () => {
    const client = makeFakeClient({
      [`repos/${REPO}/pulls/31`]: makePull({ state: 'closed', merged: true }),
    });
    expect((await readPr(client, REPO, 31, noSleep))?.state).toBe('MERGED');
  });
});

describe('baseChecksProbe', () => {
  it("reduces the base tip's runs to name, conclusion and app", async () => {
    const client = makeFakeClient({
      [`repos/${REPO}/commits/tip1/check-runs?filter=latest`]: {
        check_runs: [
          { name: 'Test', conclusion: 'failure', app: { slug: 'github-actions' } },
          { name: 'Odd', conclusion: null, app: null },
        ],
      },
    });
    expect(await baseChecksProbe(client, REPO)('tip1')).toEqual([
      { name: 'Test', conclusion: 'failure', appSlug: 'github-actions' },
      { name: 'Odd', conclusion: null, appSlug: null },
    ]);
  });

  it('soft-fails to no runs when they cannot be read', async () => {
    expect(await baseChecksProbe(makeFakeClient(), REPO)('tip1')).toEqual([]);
  });
});

describe('requiredChecksProbe', () => {
  it("collects the required contexts of the base's rulesets, once each", async () => {
    const client = makeFakeClient({
      [`repos/${REPO}/rules/branches/main`]: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Test' }, { context: 'Lint' }] },
        },
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Test' }] },
        },
      ],
    });
    expect(await requiredChecksProbe(client, REPO)('main')).toEqual(['Test', 'Lint']);
  });

  it('is null when the rules cannot be read', async () => {
    expect(await requiredChecksProbe(makeFakeClient(), REPO)('main')).toBeNull();
  });
});

describe('postCheck', () => {
  const post = {
    name: 'merge-safety',
    conclusion: 'success',
    title: 'No update required',
    summary: 'ok',
  } as const;

  it('completes a still-open run in place instead of creating another', async () => {
    const client = makeFakeClient({
      [RUNS]: {
        check_runs: [
          { id: 7, status: 'in_progress' },
          { id: 6, status: 'completed' },
        ],
      },
    });
    await postCheck(client, REPO, 'head1', post, NOW);
    expect(client.writes.map(({ method, path }) => [method, path])).toEqual([
      ['PATCH', `repos/${REPO}/check-runs/7`],
      ['POST', `repos/${REPO}/statuses/head1`],
    ]);
  });

  it('creates a run when an open one cannot be updated', async () => {
    const client = makeFakeClient({ [RUNS]: { check_runs: [{ id: 7, status: 'queued' }] } });
    client.failing.add(`repos/${REPO}/check-runs/7`);
    await postCheck(client, REPO, 'head1', post, NOW);
    expect(client.writes.map(({ path }) => path)).toContain(`repos/${REPO}/check-runs`);
  });

  it('posts a pending check as in progress, with no conclusion', async () => {
    const client = makeFakeClient({ [RUNS]: { check_runs: [] } });
    await postCheck(client, REPO, 'head1', { ...post, conclusion: 'pending' }, NOW);
    expect(client.writes[0]?.body).toEqual({
      name: 'merge-safety',
      head_sha: 'head1',
      status: 'in_progress',
      output: { title: 'No update required', summary: 'ok' },
    });
  });

  it('truncates the status description to the 140 characters GitHub accepts', async () => {
    const client = makeFakeClient({ [RUNS]: { check_runs: [] } });
    await postCheck(client, REPO, 'head1', { ...post, title: 'x'.repeat(200) }, NOW);
    const status = client.writes.at(-1)?.body as { description: string };
    expect(status.description).toHaveLength(140);
  });

  it('reports a failed status post', async () => {
    const client = makeFakeClient({ [RUNS]: { check_runs: [] } });
    client.failing.add(`repos/${REPO}/statuses/head1`);
    expect(await postCheck(client, REPO, 'head1', post, NOW)).toBe(false);
  });
});

describe('openPullsOnBase', () => {
  it('lists the open PRs on the branch with their heads', async () => {
    const client = makeFakeClient({
      [`repos/${REPO}/pulls?state=open&base=feature%2Fbig&per_page=100`]: [
        { number: 3, head: { sha: 'h3' } },
      ],
    });
    expect(await openPullsOnBase(client, REPO, 'feature/big')).toEqual([
      { number: 3, headSha: 'h3' },
    ]);
  });

  it('is undefined when they cannot be listed', async () => {
    expect(await openPullsOnBase(makeFakeClient(), REPO, 'main')).toBeUndefined();
  });
});
