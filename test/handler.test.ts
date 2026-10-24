import { describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../src/handler.js';
import { handleWebhook } from '../src/handler.js';
import type { Payload } from '../src/payload.js';
import {
  BOT_LOGIN,
  makeDeps,
  makePullRequestEvent,
  makeRepository,
  sign,
  TEMPLATE_CONFIG,
} from './fixtures.js';

function makeRequest(
  payload: Payload,
  overrides: { event?: string; signature?: string | null; body?: string } = {},
): WebhookRequest {
  const body = overrides.body ?? JSON.stringify(payload);
  const headers: Record<string, string | null> = {
    'x-github-event': overrides.event ?? 'pull_request',
    'x-github-delivery': 'delivery-1',
    'x-hub-signature-256': overrides.signature === undefined ? sign(body) : overrides.signature,
  };
  return { header: (name) => headers[name] ?? null, body };
}

describe('handleWebhook: signature', () => {
  it('rejects an unsigned delivery with 401', () => {
    const response = handleWebhook(
      makeRequest(makePullRequestEvent(), { signature: null }),
      makeDeps(),
    );
    expect(response.status).toBe(401);
  });

  it('does no work for a mis-signed delivery', () => {
    const deps = makeDeps();
    const response = handleWebhook(
      makeRequest(makePullRequestEvent(), { signature: sign('{}', 'forged') }),
      deps,
    );
    expect([response.background, deps.minted]).toEqual([undefined, []]);
  });
});

describe('handleWebhook: accepted', () => {
  it('accepts an enabled repo event with 202', () => {
    const response = handleWebhook(makeRequest(makePullRequestEvent()), makeDeps());
    expect([response.status, response.body]).toEqual([202, { accepted: true }]);
  });

  it('reconciles in the background, after the response', async () => {
    const deps = makeDeps();
    const response = handleWebhook(makeRequest(makePullRequestEvent()), deps);
    expect(deps.reconciles).toEqual([]);
    await response.background;
    expect(deps.reconciles.map(({ pr }) => pr)).toEqual([31]);
  });

  it("uses the enabled repo's config", async () => {
    const deps = makeDeps();
    await handleWebhook(makeRequest(makePullRequestEvent()), deps).background;
    expect(deps.reconciles[0]?.policy).toBe(TEMPLATE_CONFIG.policy);
  });
});

describe('handleWebhook: ignored', () => {
  it('acknowledges an installed repo that is not enabled, with no work', () => {
    const deps = makeDeps();
    const event = makePullRequestEvent({
      repository: makeRepository({ full_name: 'rmartz/personal-budget', name: 'personal-budget' }),
    });
    const response = handleWebhook(makeRequest(event), deps);
    expect([response.status, response.body, response.background]).toEqual([
      200,
      { ignored: 'repo-not-enabled' },
      undefined,
    ]);
  });

  it("acknowledges the App's own label write without reconciling", () => {
    const event = makePullRequestEvent({ action: 'labeled', sender: { login: BOT_LOGIN } });
    const response = handleWebhook(makeRequest(event), makeDeps());
    expect(response.body).toEqual({ ignored: 'self-triggered' });
  });

  it('acknowledges a ping', () => {
    const response = handleWebhook(makeRequest({ zen: 'hi' }, { event: 'ping' }), makeDeps());
    expect(response.body).toEqual({ ignored: 'unsubscribed-event' });
  });

  it('ignores a repo whose config disappears between decide and run', () => {
    let calls = 0;
    const deps = makeDeps({
      repoConfig: () => (calls++ === 0 ? TEMPLATE_CONFIG : undefined),
    });
    const response = handleWebhook(makeRequest(makePullRequestEvent()), deps);
    expect(response.body).toEqual({ ignored: 'repo-not-enabled' });
  });
});

describe('handleWebhook: malformed', () => {
  it('rejects a signed body that is not a JSON object with 400', () => {
    const response = handleWebhook(makeRequest({}, { body: '[1,2]' }), makeDeps());
    expect(response.status).toBe(400);
  });

  it('rejects a signed body that is not JSON at all with 400', () => {
    const response = handleWebhook(makeRequest({}, { body: 'not json' }), makeDeps());
    expect(response.status).toBe(400);
  });

  it('rejects a delivery with no event header with 400', () => {
    const body = JSON.stringify(makePullRequestEvent());
    const request: WebhookRequest = {
      header: (name) => (name === 'x-hub-signature-256' ? sign(body) : null),
      body,
    };
    expect(handleWebhook(request, makeDeps()).status).toBe(400);
  });
});

describe('handleWebhook: replay', () => {
  it('reconciles a duplicate delivery the same way, so it converges', async () => {
    const deps = makeDeps();
    const request = makeRequest(makePullRequestEvent());
    await handleWebhook(request, deps).background;
    await handleWebhook(request, deps).background;
    expect(deps.reconciles.map(({ pr, policy }) => ({ pr, policy }))).toEqual([
      { pr: 31, policy: TEMPLATE_CONFIG.policy },
      { pr: 31, policy: TEMPLATE_CONFIG.policy },
    ]);
  });
});
