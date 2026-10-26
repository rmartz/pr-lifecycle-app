import { describe, expect, it } from 'vitest';
import type { EventRepository } from '../src/events.js';
import { handleGateWebhook } from '../src/gate-handler.js';
import type { WebhookRequest } from '../src/handler.js';
import type { Payload } from '../src/payload.js';
import { RATE_LIMIT_FLOOR } from '../src/rate-limit.js';
import { runMergeSafetyEvaluate, runMergeSafetyInvalidate } from '../src/run-merge-safety.js';
import type { FakeClient } from './fake-client.js';
import { makeFakeClient } from './fake-client.js';
import {
  INSTALLATION_ID,
  makePullRequestEvent,
  makeRepository,
  makeWorkflowRunEvent,
  REPO_ID,
  sign,
} from './fixtures.js';
import { makeGateDeps } from './gate-fixtures.js';
import { makeMergeSafetyRoutes, MS_SHADOW, REPO } from './merge-safety-fixtures.js';

// The gate's GitHub cost per delivery, pinned. The gate shares one hourly
// budget per installation across a whole fleet, so a change to these numbers
// should be deliberate.

const REPOSITORY: EventRepository = {
  installationId: INSTALLATION_ID,
  id: REPO_ID,
  owner: 'rmartz',
  name: 'firebase-nextjs-template',
  fullName: REPO,
};

const calls = (client: FakeClient) => client.reads.length + client.writes.length;

function makeOpenPrs(
  count: number,
  options: { current?: boolean; baseMessage?: string } = {},
): FakeClient {
  const routes: Record<string, unknown> = {};
  const pulls = [];
  for (let i = 0; i < count; i++) {
    Object.assign(routes, makeMergeSafetyRoutes({ pr: 40 + i, head: `head${i}`, ...options }));
    pulls.push({ number: 40 + i, head: { sha: `head${i}` } });
  }
  routes[`repos/${REPO}/pulls?state=open&base=main&per_page=100`] = pulls;
  return makeFakeClient(routes);
}

function makeRequest(payload: Payload, event: string): WebhookRequest {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'x-github-event': event,
    'x-github-delivery': 'delivery-b',
    'x-hub-signature-256': sign(body),
  };
  return { header: (name) => headers[name] ?? null, body };
}

describe('API cost: merge-safety', () => {
  it('evaluates one PR in 9 calls (7 reads, 2 writes)', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    await runMergeSafetyEvaluate(
      { repository: REPOSITORY, prs: [31], headSha: undefined },
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect([client.reads.length, client.writes.length]).toEqual([7, 2]);
  });

  it('fans out to 5 stale PRs in 54 calls, sharing the base reads', async () => {
    const client = makeOpenPrs(5);
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      'tip1',
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(calls(client)).toBe(54);
  });

  it('re-checks 5 PRs whose verdicts are current in 9 reads and no writes', async () => {
    const client = makeOpenPrs(5);
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-1', deps);
    const first = calls(client);
    const writes = client.writes.length;
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-2', deps);
    expect([calls(client) - first, client.writes.length - writes]).toEqual([9, 0]);
  });

  it('re-checks 5 PRs whose current verdict is Update required in 9 reads and no writes', async () => {
    const client = makeOpenPrs(5, { current: false, baseMessage: 'ci: change a workflow' });
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-1', deps);
    const first = calls(client);
    const writes = client.writes.length;
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-2', deps);
    expect([calls(client) - first, client.writes.length - writes]).toEqual([9, 0]);
  });

  it('re-checks 5 PRs after a required base check turns green in 9 reads and no writes', async () => {
    const client = makeOpenPrs(5);
    const deps = makeGateDeps({ client });
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-1', deps);
    client.routes.set(`repos/${REPO}/rules/branches/main`, [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'CI' }] },
      },
    ]);
    client.routes.set(`repos/${REPO}/commits/tip1/check-runs?filter=latest`, {
      check_runs: [{ name: 'CI', conclusion: 'success', app: { slug: 'github-actions' } }],
    });
    const first = calls(client);
    const writes = client.writes.length;
    await runMergeSafetyInvalidate(REPOSITORY, 'main', 'tip1', MS_SHADOW, 'd-2', deps);
    expect([calls(client) - first, client.writes.length - writes]).toEqual([9, 0]);
  });

  it('reads each base commit once for the whole fan-out, not once per PR', async () => {
    const client = makeOpenPrs(5, { current: false });
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      'tip1',
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(client.reads.filter((path) => path === `repos/${REPO}/commits/tip1`)).toHaveLength(1);
  });

  it('skips a stale base CI run in 1 read', async () => {
    const client = makeOpenPrs(5);
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      'old-tip',
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client }),
    );
    expect(calls(client)).toBe(1);
  });
});

describe('API cost: deliveries that cost nothing', () => {
  it('ignores a status-started workflow run without minting a token', () => {
    const deps = makeGateDeps({ mergeSafety: MS_SHADOW });
    const event = makeWorkflowRunEvent(
      { head_branch: 'main', event: 'status', head_sha: 'tip1' },
      { repository: makeRepository({ default_branch: 'main' }) },
    );
    handleGateWebhook(makeRequest(event, 'workflow_run'), deps);
    expect(deps.minted).toEqual([]);
  });

  it('ignores a lifecycle label the actor writes, for merge-safety', () => {
    const deps = makeGateDeps({ mergeSafety: MS_SHADOW, config: undefined });
    const event = makePullRequestEvent({
      action: 'labeled',
      label: { name: 'review requested' },
      sender: { login: 'rmartz-pr-lifecycle[bot]' },
    });
    const response = handleGateWebhook(makeRequest(event, 'pull_request'), deps);
    expect([response.body, deps.minted]).toEqual([
      { prPolicy: 'repo-not-enabled', mergeSafety: 'unhandled-action' },
      [],
    ]);
  });
});

describe('API cost: out of budget, the gate posts nothing', () => {
  const starved = { rateLimitRemaining: () => RATE_LIMIT_FLOOR - 1 };

  it('posts no merge-safety verdict below the floor', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    await runMergeSafetyEvaluate(
      { repository: REPOSITORY, prs: [31], headSha: undefined },
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client, overrides: starved }),
    );
    expect(client.writes).toEqual([]);
  });

  it('posts no Could not evaluate when a rate limit cuts the facts short', async () => {
    const routes = makeMergeSafetyRoutes();
    delete routes[`repos/${REPO}/compare/tip1...head1`];
    const client = makeFakeClient(routes);
    let remaining = 4321;
    const getJson = client.getJson.bind(client);
    client.getJson = async (path) => {
      const out = await getJson(path);
      if (out === null) remaining = 0;
      return out;
    };
    const deps = makeGateDeps({
      client,
      overrides: {
        rateLimitRemaining: () => remaining,
        lastFailure: () => ({ status: 403, path: '/repos/x/compare' }),
      },
    });
    await runMergeSafetyEvaluate(
      { repository: REPOSITORY, prs: [31], headSha: undefined },
      MS_SHADOW,
      'd-1',
      deps,
    );
    expect([client.writes, deps.log.entries.at(-1)?.message]).toEqual([
      [],
      'skipped a verdict the rate limit cut short; nothing posted',
    ]);
  });

  it('marks nothing pending when a fan-out starts below the floor', async () => {
    const client = makeOpenPrs(3);
    await runMergeSafetyInvalidate(
      REPOSITORY,
      'main',
      'tip1',
      MS_SHADOW,
      'd-1',
      makeGateDeps({ client, overrides: starved }),
    );
    expect(client.writes).toEqual([]);
  });

  it('posts no pr-policy verdict below the floor', async () => {
    const deps = makeGateDeps({ overrides: starved });
    await handleGateWebhook(makeRequest(makePullRequestEvent(), 'pull_request'), deps).background;
    expect(deps.calls.map(({ op }) => op)).not.toContain('postVerdict');
  });
});
