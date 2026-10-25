import { describe, expect, it } from 'vitest';
import { handleGateWebhook } from '../src/gate-handler.js';
import type { WebhookRequest } from '../src/handler.js';
import type { Payload } from '../src/payload.js';
import { makePullRequestEvent, makeRepository, sign } from './fixtures.js';
import { makeFakeClient } from './fake-client.js';
import { GATE_BOT, makeGateDeps, makeStatusEvent, SHADOW_CONFIG } from './gate-fixtures.js';
import { makeMergeSafetyRoutes, MS_SHADOW, REPO } from './merge-safety-fixtures.js';

function makeRequest(
  payload: Payload,
  overrides: { event?: string; signature?: string | null; body?: string } = {},
): WebhookRequest {
  const body = overrides.body ?? JSON.stringify(payload);
  const headers: Record<string, string | null> = {
    'x-github-event': overrides.event ?? 'pull_request',
    'x-github-delivery': 'delivery-9',
    'x-hub-signature-256': overrides.signature === undefined ? sign(body) : overrides.signature,
  };
  return { header: (name) => headers[name] ?? null, body };
}

describe('handleGateWebhook: signature', () => {
  it('rejects a mis-signed delivery with 401', () => {
    const body = JSON.stringify(makePullRequestEvent());
    const response = handleGateWebhook(
      makeRequest({}, { body, signature: sign(body, 'forged') }),
      makeGateDeps(),
    );
    expect(response.status).toBe(401);
  });

  it('does no work for a mis-signed delivery', () => {
    const deps = makeGateDeps();
    const body = JSON.stringify(makePullRequestEvent());
    const response = handleGateWebhook(
      makeRequest({}, { body, signature: sign(body, 'forged') }),
      deps,
    );
    expect([response.background, deps.minted]).toEqual([undefined, []]);
  });

  it('rejects a signed body that is not a payload with 400', () => {
    const response = handleGateWebhook(makeRequest({}, { body: '[1]' }), makeGateDeps());
    expect(response.status).toBe(400);
  });
});

describe('handleGateWebhook: accepted', () => {
  it('accepts a PR event for an enabled repo with 202', () => {
    const response = handleGateWebhook(makeRequest(makePullRequestEvent()), makeGateDeps());
    expect([response.status, response.body]).toEqual([
      202,
      { prPolicy: 'accepted', mergeSafety: 'repo-not-enabled' },
    ]);
  });

  it('evaluates in the background, after the response', async () => {
    const deps = makeGateDeps();
    const response = handleGateWebhook(makeRequest(makePullRequestEvent()), deps);
    expect(deps.calls).toEqual([]);
    await response.background;
    expect(deps.calls.map(({ op }) => op)).toContain('postVerdict');
  });

  it('evaluates the PRs at a sign-off status', async () => {
    const deps = makeGateDeps({ openPrs: [60] });
    await handleGateWebhook(makeRequest(makeStatusEvent(), { event: 'status' }), deps).background;
    expect(deps.calls.find(({ op }) => op === 'gatherFacts')?.args).toEqual([
      'rmartz/firebase-nextjs-template',
      60,
    ]);
  });

  it("uses the repo's pr-policy mode for the verdict name", async () => {
    const deps = makeGateDeps({ config: { ...SHADOW_CONFIG, mode: 'live' } });
    await handleGateWebhook(makeRequest(makePullRequestEvent()), deps).background;
    expect(deps.calls.find(({ op }) => op === 'postVerdict')?.args[3]).toBe('pr-policy');
  });
});

describe('handleGateWebhook: ignored', () => {
  it('acknowledges a repo where pr-policy is not enabled, with no work', () => {
    const deps = makeGateDeps();
    const event = makePullRequestEvent({
      repository: makeRepository({ full_name: 'rmartz/personal-budget', name: 'personal-budget' }),
    });
    const response = handleGateWebhook(makeRequest(event), deps);
    expect([response.status, response.body, response.background]).toEqual([
      200,
      { prPolicy: 'repo-not-enabled', mergeSafety: 'repo-not-enabled' },
      undefined,
    ]);
  });

  it('acknowledges a repo whose pr-policy mode is off, with no work', () => {
    const response = handleGateWebhook(
      makeRequest(makePullRequestEvent()),
      makeGateDeps({ config: undefined }),
    );
    expect(response.body).toEqual({
      prPolicy: 'repo-not-enabled',
      mergeSafety: 'repo-not-enabled',
    });
  });

  it("acknowledges the gate's own label write without evaluating", () => {
    const event = makePullRequestEvent({ action: 'labeled', sender: { login: GATE_BOT } });
    const response = handleGateWebhook(
      makeRequest(event),
      makeGateDeps({ mergeSafety: MS_SHADOW }),
    );
    expect(response.body).toEqual({ prPolicy: 'self-triggered', mergeSafety: 'self-triggered' });
  });

  it("acknowledges the gate's own status without evaluating", () => {
    const event = makeStatusEvent({ context: 'pr-policy (app)' });
    const response = handleGateWebhook(makeRequest(event, { event: 'status' }), makeGateDeps());
    expect(response.body).toEqual({
      prPolicy: 'unhandled-action',
      mergeSafety: 'unsubscribed-event',
    });
  });

  it('ignores a repo whose config disappears between decide and run', () => {
    let calls = 0;
    const deps = makeGateDeps({
      overrides: { prPolicyConfig: () => (calls++ === 0 ? SHADOW_CONFIG : undefined) },
    });
    const response = handleGateWebhook(makeRequest(makePullRequestEvent()), deps);
    expect(response.body).toMatchObject({ prPolicy: 'repo-not-enabled' });
  });
});

describe('handleGateWebhook: replay', () => {
  it('evaluates a duplicate delivery the same way, so the verdict converges', async () => {
    const deps = makeGateDeps();
    const request = makeRequest(makePullRequestEvent());
    await handleGateWebhook(request, deps).background;
    await handleGateWebhook(request, deps).background;
    const verdicts = deps.calls.filter(({ op }) => op === 'postVerdict').map(({ args }) => args);
    expect(verdicts).toEqual([
      [31, 'head1', 'failure', 'pr-policy (app)'],
      [31, 'head1', 'failure', 'pr-policy (app)'],
    ]);
  });
});

describe('handleGateWebhook: merge-safety', () => {
  it('runs both tools on a PR event when both are enabled', () => {
    const response = handleGateWebhook(
      makeRequest(makePullRequestEvent()),
      makeGateDeps({ mergeSafety: MS_SHADOW }),
    );
    expect(response.body).toEqual({ prPolicy: 'accepted', mergeSafety: 'accepted' });
  });

  it('posts the merge-safety shadow check in the background', async () => {
    const client = makeFakeClient(makeMergeSafetyRoutes());
    const deps = makeGateDeps({ mergeSafety: MS_SHADOW, client, config: undefined });
    await handleGateWebhook(makeRequest(makePullRequestEvent()), deps).background;
    expect(
      client.writes.find(({ path }) => path === `repos/${REPO}/check-runs`)?.body,
    ).toMatchObject({ name: 'merge-safety (app)' });
  });

  it('accepts a push to the base as an invalidation for merge-safety only', () => {
    const push = {
      installation: { id: 777 },
      repository: makeRepository({ default_branch: 'main' }),
      sender: { login: 'rmartz' },
      ref: 'refs/heads/main',
      deleted: false,
    };
    const response = handleGateWebhook(
      makeRequest(push, { event: 'push' }),
      makeGateDeps({ mergeSafety: MS_SHADOW }),
    );
    expect([response.status, response.body]).toEqual([
      202,
      { prPolicy: 'unsubscribed-event', mergeSafety: 'accepted' },
    ]);
  });
});

describe('handleGateWebhook: cost', () => {
  it("logs each accepted delivery's API calls and remaining budget when done", async () => {
    const deps = makeGateDeps();
    await handleGateWebhook(makeRequest(makePullRequestEvent()), deps).background;
    expect(deps.log.entries.at(-1)).toMatchObject({
      message: 'delivery done',
      fields: { event: 'pull_request', apiCalls: 17, rateLimitRemaining: 4321 },
    });
  });
});
