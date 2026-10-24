import { describe, expect, it } from 'vitest';
import { handleHttpRequest, productionDeps } from '../src/http.js';
import { makeDeps, makeLogger, makePullRequestEvent, SECRET, sign } from './fixtures.js';

const ENV = {
  PR_LIFECYCLE_CLIENT_ID: 'Iv1.client',
  PR_LIFECYCLE_PRIVATE_KEY: 'key',
  PR_LIFECYCLE_WEBHOOK_SECRET: SECRET,
};

function makeHttpRequest(body: string, signature: string): Request {
  return new Request('https://app.example/api/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': signature,
    },
    body,
  });
}

describe('handleHttpRequest', () => {
  it('refuses every delivery with 500 while a secret is missing', async () => {
    const log = makeLogger();
    const body = JSON.stringify(makePullRequestEvent());
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body)), {
      env: {},
      waitUntil: () => undefined,
      log,
    });
    expect(response.status).toBe(500);
  });

  it('hands the reconcile to waitUntil and responds 202', async () => {
    const deps = makeDeps();
    const kept: Promise<unknown>[] = [];
    const body = JSON.stringify(makePullRequestEvent());
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body)), {
      env: ENV,
      waitUntil: (promise) => kept.push(promise),
      log: deps.log,
      deps: () => deps,
    });
    await Promise.all(kept);
    expect([response.status, deps.reconciles.length]).toEqual([202, 1]);
  });

  it('responds 401 to a bad signature without waiting on anything', async () => {
    const kept: Promise<unknown>[] = [];
    const response = await handleHttpRequest(makeHttpRequest('{}', 'sha256=00'), {
      env: ENV,
      waitUntil: (promise) => kept.push(promise),
      log: makeLogger(),
    });
    expect([response.status, kept.length]).toEqual([401, 0]);
  });
});

describe('productionDeps', () => {
  it('carries the configured secret and bot login', () => {
    const deps = productionDeps(
      { clientId: 'Iv1.client', privateKey: 'key', webhookSecret: 's', botLogin: 'b[bot]' },
      makeLogger(),
    );
    expect([deps.webhookSecret, deps.botLogin]).toEqual(['s', 'b[bot]']);
  });

  it('enables the proof-of-concept repository', () => {
    const deps = productionDeps(
      { clientId: 'Iv1.client', privateKey: 'key', webhookSecret: 's', botLogin: 'b[bot]' },
      makeLogger(),
    );
    expect(deps.repoConfig('rmartz/firebase-nextjs-template')?.dryRun).toBe(true);
  });
});
