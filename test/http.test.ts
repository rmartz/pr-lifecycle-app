import { describe, expect, it } from 'vitest';
import type { GateHandlerDeps } from '../src/gate-handler.js';
import { gateDeps, handleHttpRequest, productionDeps } from '../src/http.js';
import type { ServerConfig } from '../src/server-config.js';
import { makeGateDeps } from './gate-fixtures.js';
import { makeDeps, makeLogger, makePullRequestEvent, SECRET, sign } from './fixtures.js';

const ENV = {
  PR_APP_ROLE: 'actor',
  PR_LIFECYCLE_CLIENT_ID: 'Iv1.client',
  PR_LIFECYCLE_PRIVATE_KEY: 'key',
  PR_LIFECYCLE_WEBHOOK_SECRET: SECRET,
};

const GATE_SECRET = 'gate-webhook-secret';

const GATE_ENV = {
  PR_APP_ROLE: 'gate',
  PR_GATE_CLIENT_ID: 'Iv1.gate',
  PR_GATE_PRIVATE_KEY: 'gate-key',
  PR_GATE_WEBHOOK_SECRET: GATE_SECRET,
};

const CONFIG: ServerConfig = {
  role: 'actor',
  clientId: 'Iv1.client',
  privateKey: 'key',
  webhookSecret: 's',
  botLogin: 'b[bot]',
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
    const body = JSON.stringify(makePullRequestEvent());
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body)), {
      env: { PR_APP_ROLE: 'actor' },
      waitUntil: () => undefined,
      log: makeLogger(),
    });
    expect(response.status).toBe(500);
  });

  it('refuses every delivery with 500 while the role is unset', async () => {
    const env = { ...ENV, PR_APP_ROLE: undefined };
    const body = JSON.stringify(makePullRequestEvent());
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body)), {
      env,
      waitUntil: () => undefined,
      log: makeLogger(),
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

describe('handleHttpRequest: roles', () => {
  it('serves the gate handler, never the reconciler, on a gate deployment', async () => {
    const actor = makeDeps();
    const body = JSON.stringify(makePullRequestEvent());
    const gate = makeGateDeps({ overrides: { webhookSecret: GATE_SECRET } });
    const kept: Promise<unknown>[] = [];
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body, GATE_SECRET)), {
      env: { ...ENV, ...GATE_ENV },
      waitUntil: (promise) => kept.push(promise),
      log: makeLogger(),
      deps: () => actor,
      gateDeps: () => gate,
    });
    await Promise.all(kept);
    expect([response.status, actor.minted, actor.reconciles]).toEqual([202, [], []]);
  });

  it("verifies a gate delivery with the gate's secret, rejecting the actor's", async () => {
    const body = JSON.stringify(makePullRequestEvent());
    const response = await handleHttpRequest(makeHttpRequest(body, sign(body, SECRET)), {
      env: { ...ENV, ...GATE_ENV },
      waitUntil: () => undefined,
      log: makeLogger(),
    });
    expect(response.status).toBe(401);
  });

  it('wires the gate handler with the gate config only', async () => {
    const seen: ServerConfig[] = [];
    const body = JSON.stringify(makePullRequestEvent());
    await handleHttpRequest(makeHttpRequest(body, sign(body, GATE_SECRET)), {
      env: { ...ENV, ...GATE_ENV },
      waitUntil: () => undefined,
      log: makeLogger(),
      gateDeps: (config): GateHandlerDeps => {
        seen.push(config);
        return makeGateDeps({ overrides: { webhookSecret: GATE_SECRET } });
      },
    });
    expect(seen.map(({ role, clientId }) => ({ role, clientId }))).toEqual([
      { role: 'gate', clientId: 'Iv1.gate' },
    ]);
  });

  it('never runs the gate handler on an actor deployment', async () => {
    let gateWired = false;
    const deps = makeDeps();
    const body = JSON.stringify(makePullRequestEvent());
    await handleHttpRequest(makeHttpRequest(body, sign(body)), {
      env: { ...GATE_ENV, ...ENV },
      waitUntil: () => undefined,
      log: deps.log,
      deps: () => deps,
      gateDeps: () => {
        gateWired = true;
        return makeGateDeps();
      },
    });
    expect(gateWired).toBe(false);
  });
});

describe('gateDeps', () => {
  const GATE_CONFIG: ServerConfig = { ...CONFIG, role: 'gate', botLogin: 'rmartz-pr-gate[bot]' };

  it('carries the gate secret and bot login', () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    expect([deps.webhookSecret, deps.botLogin]).toEqual(['s', 'rmartz-pr-gate[bot]']);
  });

  it('runs pr-policy live on the proof-of-concept repository', () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    expect(deps.prPolicyConfig('rmartz/firebase-nextjs-template')?.mode).toBe('live');
  });

  it('leaves pr-policy off everywhere else', () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    expect(deps.prPolicyConfig('rmartz/personal-budget')).toBeUndefined();
  });

  it('shadows merge-safety on the proof-of-concept repository', () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    expect(deps.mergeSafetyConfig('rmartz/firebase-nextjs-template')?.mode).toBe('shadow');
  });

  it('knows no rate limit before the client has made a request', () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    deps.createClient('ghs_unused');
    expect(deps.rateLimitRemaining()).toBeUndefined();
  });

  it('tells the time and sleeps for real', async () => {
    const deps = gateDeps(GATE_CONFIG, makeLogger());
    await deps.sleep(0);
    expect(deps.now()).toBeInstanceOf(Date);
  });
});

describe('productionDeps', () => {
  it('carries the configured secret and bot login', () => {
    const deps = productionDeps(CONFIG, makeLogger());
    expect([deps.webhookSecret, deps.botLogin]).toEqual(['s', 'b[bot]']);
  });

  it('enables the proof-of-concept repository', () => {
    const deps = productionDeps(CONFIG, makeLogger());
    expect(deps.prLifecycleConfig('rmartz/firebase-nextjs-template')?.mode).toBe('live');
  });

  it('boots no sandbox for a run that never calls git', async () => {
    const deps = productionDeps(CONFIG, makeLogger());
    await expect(deps.createGit('ghs_token').close()).resolves.toBeUndefined();
  });
});
