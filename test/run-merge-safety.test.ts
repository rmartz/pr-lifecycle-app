import { describe, expect, it } from 'vitest';
import type { EventRepository } from '../src/events.js';
import { mergeSafetyName } from '../src/merge-safety-evaluate.js';
import {
  RATE_LIMIT_FLOOR,
  runMergeSafetyEvaluate,
  runMergeSafetyInvalidate,
} from '../src/run-merge-safety.js';
import type { FakeClient } from './fake-client.js';
import { makeFakeClient } from './fake-client.js';
import { INSTALLATION_ID, REPO_ID } from './fixtures.js';
import { makeGateDeps } from './gate-fixtures.js';
import {
  makeMergeSafetyRoutes,
  makePull,
  MS_LIVE,
  MS_SHADOW,
  REPO,
} from './merge-safety-fixtures.js';

const REPOSITORY: EventRepository = {
  installationId: INSTALLATION_ID,
  id: REPO_ID,
  owner: 'rmartz',
  name: 'firebase-nextjs-template',
  fullName: REPO,
};

const target = (prs: number[], headSha?: string) => ({ repository: REPOSITORY, prs, headSha });

const checkRunPosts = (client: FakeClient) =>
  client.writes.filter(({ path }) => path === `repos/${REPO}/check-runs`);
const statusPosts = (client: FakeClient) =>
  client.writes.filter(({ path }) => path.startsWith(`repos/${REPO}/statuses/`));

describe('runMergeSafetyEvaluate: verdicts', () => {
  it('posts a current PR as safe, under the shadow name', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(checkRunPosts(client)).toMatchObject([
      {
        body: {
          name: 'merge-safety (app)',
          head_sha: 'head1',
          status: 'completed',
          conclusion: 'success',
        },
      },
    ]);
  });

  it('mirrors the verdict to a commit status of the same name', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(statusPosts(client)).toMatchObject([
      {
        path: `repos/${REPO}/statuses/head1`,
        body: { state: 'success', context: 'merge-safety (app)' },
      },
    ]);
  });

  it('fails safe as Could not evaluate when the facts cannot be gathered', async () => {
    const routes = makeMergeSafetyRoutes();
    delete routes[`repos/${REPO}/compare/tip1...head1`];
    const client = makeFakeClient(routes);
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(checkRunPosts(client)[0]?.body).toMatchObject({
      conclusion: 'failure',
      output: { title: 'Could not evaluate' },
    });
  });

  it('uses the real name when live', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    await runMergeSafetyEvaluate(target([31]), MS_LIVE, 'd-1', makeGateDeps({ client }));
    expect(checkRunPosts(client)[0]?.body).toMatchObject({ name: 'merge-safety' });
  });
});

describe('runMergeSafetyEvaluate: labels', () => {
  const conflicted = () => {
    const routes = makeMergeSafetyRoutes();
    routes[`repos/${REPO}/pulls/31`] = makePull({ mergeable: false });
    return makeFakeClient(routes);
  };
  const labelWrites = (client: FakeClient) =>
    client.writes.filter(({ path }) => path.includes('/labels'));

  it('reconciles the labels merge-safety owns when live', async () => {
    const client = conflicted();
    await runMergeSafetyEvaluate(target([31]), MS_LIVE, 'd-1', makeGateDeps({ client }));
    expect(labelWrites(client)[0]).toEqual({
      method: 'POST',
      path: `repos/${REPO}/issues/31/labels`,
      body: { labels: ['merge conflict'] },
    });
  });

  it('never writes labels in shadow', async () => {
    const client = conflicted();
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(labelWrites(client)).toEqual([]);
  });
});

describe('runMergeSafetyEvaluate: targets', () => {
  it('skips a PR that is no longer open', async () => {
    const routes = makeMergeSafetyRoutes();
    routes[`repos/${REPO}/pulls/31`] = makePull({ state: 'closed', merged: true });
    const client = makeFakeClient(routes);
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(client.writes).toEqual([]);
  });

  it('re-reads while GitHub is still computing mergeability', async () => {
    const routes = makeMergeSafetyRoutes();
    routes[`repos/${REPO}/pulls/31`] = makePull({ mergeable: null });
    const client = makeFakeClient(routes);
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(client.reads.filter((path) => path === `repos/${REPO}/pulls/31`)).toHaveLength(3);
  });

  it("evaluates the open PRs at a Re-run's head when it lists none", async () => {
    const routes = makeMergeSafetyRoutes();
    routes[`repos/${REPO}/commits/head1/pulls`] = [
      { number: 31, state: 'open' },
      { number: 30, state: 'closed' },
    ];
    const client = makeFakeClient(routes);
    await runMergeSafetyEvaluate(target([], 'head1'), MS_SHADOW, 'd-1', makeGateDeps({ client }));
    expect(checkRunPosts(client)).toHaveLength(1);
  });

  it('logs an unreadable PR and posts nothing', async () => {
    const client = makeFakeClient({});
    const deps = makeGateDeps({ client });
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', deps);
    expect([client.writes, deps.log.entries.at(-1)?.message]).toEqual([
      [],
      'could not read the pull request',
    ]);
  });

  it("mints the gate token for the event's installation and repository only", async () => {
    const deps = makeGateDeps({ client: makeFakeClient(makeMergeSafetyRoutes()) });
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', deps);
    expect(deps.minted).toEqual([{ installationId: 777, repo: 'firebase-nextjs-template' }]);
  });

  it('logs a token failure and does nothing', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    const deps = makeGateDeps({
      client,
      overrides: { mintToken: () => Promise.reject(new Error('HTTP 404')) },
    });
    await runMergeSafetyEvaluate(target([31]), MS_SHADOW, 'd-1', deps);
    expect([client.reads, deps.log.entries[0]?.message]).toEqual([
      [],
      'could not prepare the merge-safety run',
    ]);
  });
});

describe('runMergeSafetyInvalidate', () => {
  const twoPrs = () => {
    const routes = {
      ...makeMergeSafetyRoutes({ pr: 31, head: 'head1' }),
      ...makeMergeSafetyRoutes({ pr: 32, head: 'head2' }),
      [`repos/${REPO}/pulls?state=open&base=main&per_page=100`]: [
        { number: 31, head: { sha: 'head1' } },
        { number: 32, head: { sha: 'head2' } },
      ],
    };
    return makeFakeClient(routes);
  };

  it('marks every open PR on the moved base pending before evaluating any', async () => {
    const client = twoPrs();
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      undefined,
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(checkRunPosts(client).map(({ body }) => (body as { status: string }).status)).toEqual([
      'in_progress',
      'in_progress',
      'completed',
      'completed',
    ]);
  });

  it('re-evaluates every PR in place when the budget allows', async () => {
    const client = twoPrs();
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect(deps.log.entries.at(-1)).toMatchObject({
      message: 'invalidated',
      fields: { baseBranch: 'main', prs: 2, rateLimitRemaining: 4321 },
    });
  });

  it('stops evaluating at the rate-limit floor, leaving the rest pending', async () => {
    const client = twoPrs();
    const deps = makeGateDeps({
      client,
      overrides: { rateLimitRemaining: () => RATE_LIMIT_FLOOR - 1 },
    });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect([
      checkRunPosts(client).filter(
        ({ body }) => (body as { status: string }).status === 'completed',
      ),
      deps.log.entries.at(-1)?.level,
    ]).toEqual([[], 'warn']);
  });

  it('never has more evaluations in flight than the configured concurrency', async () => {
    const pulls = Array.from({ length: 6 }, (_, i) => ({ number: 40 + i, head: { sha: `h${i}` } }));
    const client = makeFakeClient({
      [`repos/${REPO}/pulls?state=open&base=main&per_page=100`]: pulls,
    });
    let inFlight = 0;
    let peak = 0;
    const getJson = client.getJson.bind(client);
    client.getJson = async (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      const out = await getJson(path);
      inFlight -= 1;
      return out;
    };
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      undefined,
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(peak).toBeLessThanOrEqual(MS_SHADOW.policy.concurrency);
  });

  it('logs and stops when the open PRs cannot be listed', async () => {
    const client = makeFakeClient({});
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect([client.writes, deps.log.entries.at(-1)?.message]).toEqual([
      [],
      'could not list the open PRs on the moved base',
    ]);
  });

  it('logs the failed response status with a failed listing', async () => {
    const deps = makeGateDeps({ client: makeFakeClient({}) });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect(deps.log.entries.at(-1)?.fields['failure']).toEqual({
      status: 403,
      path: '/repos/rmartz/firebase-nextjs-template/pulls',
    });
  });

  it('marks nothing pending when already below the rate-limit floor', async () => {
    const client = twoPrs();
    const deps = makeGateDeps({
      client,
      overrides: { rateLimitRemaining: () => RATE_LIMIT_FLOOR - 1 },
    });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect(checkRunPosts(client)).toEqual([]);
  });
});

describe('runMergeSafetyInvalidate: base CI runs', () => {
  const withTip = (tip: string) =>
    makeFakeClient({
      ...makeMergeSafetyRoutes({ pr: 31, head: 'head1', tip }),
      [`repos/${REPO}/pulls?state=open&base=main&per_page=100`]: [
        { number: 31, head: { sha: 'head1' } },
      ],
    });

  it("fans out for a base CI run on the branch's current tip", async () => {
    const client = withTip('tip1');
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      'tip1',
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(checkRunPosts(client).length).toBeGreaterThan(0);
  });

  it('skips a stale or redelivered base CI run with one read and no writes', async () => {
    const client = withTip('tip2');
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-1', deps);
    expect([client.writes, client.reads, deps.log.entries.at(-1)?.message]).toEqual([
      [],
      [`repos/${REPO}/branches/main`],
      'skipped a base CI run that is no longer the tip',
    ]);
  });

  it('logs an unreadable base branch with the failed response', async () => {
    const client = makeFakeClient({});
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-1', deps);
    expect(deps.log.entries.at(-1)).toMatchObject({
      message: 'could not read the base branch',
      fields: { failure: { status: 403 } },
    });
  });
});

describe('merge-safety runs never throw', () => {
  const throwing = () => {
    const client = makeFakeClient();
    client.list = () => Promise.reject(new Error('socket hang up'));
    return client;
  };

  it('logs an invalidation whose PR listing throws', async () => {
    const deps = makeGateDeps({ client: throwing() });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', undefined, MS_SHADOW, 'd-1', deps);
    expect(deps.log.entries.at(-1)).toMatchObject({
      level: 'error',
      message: 'merge-safety run failed',
      fields: { error: 'socket hang up' },
    });
  });

  it('logs a Re-run whose head lookup throws', async () => {
    const deps = makeGateDeps({ client: throwing() });
    await runMergeSafetyEvaluate(target([], 'head1'), MS_SHADOW, 'd-1', deps);
    expect(deps.log.entries.at(-1)?.message).toBe('merge-safety run failed');
  });
});

describe('mergeSafetyName', () => {
  it('is the shadow name in shadow mode', () => {
    expect(mergeSafetyName(MS_SHADOW)).toBe('merge-safety (app)');
  });

  it('is merge-safety in live mode', () => {
    expect(mergeSafetyName(MS_LIVE)).toBe('merge-safety');
  });
});
