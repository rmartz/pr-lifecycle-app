import { describe, expect, it } from 'vitest';
import type { GateHandlerDeps } from '../src/gate-handler.js';
import { handleGateWebhook } from '../src/gate-handler.js';
import type { WebhookRequest } from '../src/handler.js';
import { makeLogger, makePullRequestEvent, SECRET, sign } from './fixtures.js';

function makeGateDeps(): GateHandlerDeps {
  return { webhookSecret: SECRET, botLogin: 'rmartz-pr-gate[bot]', log: makeLogger() };
}

function makeRequest(body: string, signature: string | null): WebhookRequest {
  const headers: Record<string, string | null> = {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'delivery-9',
    'x-hub-signature-256': signature,
  };
  return { header: (name) => headers[name] ?? null, body };
}

describe('handleGateWebhook', () => {
  it('rejects a mis-signed delivery with 401', () => {
    const body = JSON.stringify(makePullRequestEvent());
    const response = handleGateWebhook(makeRequest(body, sign(body, 'forged')), makeGateDeps());
    expect(response.status).toBe(401);
  });

  it('rejects a signed body that is not a payload with 400', () => {
    const response = handleGateWebhook(makeRequest('[1]', sign('[1]')), makeGateDeps());
    expect(response.status).toBe(400);
  });

  it('acknowledges a verified delivery without work while no gate tool is routed', () => {
    const body = JSON.stringify(makePullRequestEvent());
    const response = handleGateWebhook(makeRequest(body, sign(body)), makeGateDeps());
    expect([response.status, response.body, response.background]).toEqual([
      200,
      { ignored: 'unsubscribed-event' },
      undefined,
    ]);
  });
});
