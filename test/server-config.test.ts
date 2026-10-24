import { describe, expect, it } from 'vitest';
import { readServerConfig } from '../src/server-config.js';

const ACTOR_ENV = {
  PR_APP_ROLE: 'actor',
  PR_LIFECYCLE_CLIENT_ID: 'Iv1.client',
  PR_LIFECYCLE_PRIVATE_KEY: '-----BEGIN KEY-----\\nabc\\n-----END KEY-----',
  PR_LIFECYCLE_WEBHOOK_SECRET: 'hook-secret',
};

const GATE_ENV = {
  PR_APP_ROLE: 'gate',
  PR_GATE_CLIENT_ID: 'Iv1.gate',
  PR_GATE_PRIVATE_KEY: 'gate-key',
  PR_GATE_WEBHOOK_SECRET: 'gate-hook-secret',
};

describe('readServerConfig: actor', () => {
  it('reads the actor secrets and unescapes the private key', () => {
    expect(readServerConfig(ACTOR_ENV)).toEqual({
      kind: 'ok',
      config: {
        role: 'actor',
        clientId: 'Iv1.client',
        privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
        webhookSecret: 'hook-secret',
        botLogin: 'rmartz-pr-lifecycle[bot]',
      },
    });
  });

  it('derives the bot login from a configured slug', () => {
    expect(readServerConfig({ ...ACTOR_ENV, PR_LIFECYCLE_APP_SLUG: 'my-app' })).toMatchObject({
      config: { botLogin: 'my-app[bot]' },
    });
  });

  it('reports every missing or empty secret by name', () => {
    expect(
      readServerConfig({
        PR_APP_ROLE: 'actor',
        PR_LIFECYCLE_CLIENT_ID: 'Iv1.client',
        PR_LIFECYCLE_WEBHOOK_SECRET: '',
      }),
    ).toEqual({
      kind: 'missing',
      names: ['PR_LIFECYCLE_PRIVATE_KEY', 'PR_LIFECYCLE_WEBHOOK_SECRET'],
    });
  });
});

describe('readServerConfig: gate', () => {
  it("reads only the gate App's secrets", () => {
    expect(readServerConfig({ ...ACTOR_ENV, ...GATE_ENV })).toEqual({
      kind: 'ok',
      config: {
        role: 'gate',
        clientId: 'Iv1.gate',
        privateKey: 'gate-key',
        webhookSecret: 'gate-hook-secret',
        botLogin: 'rmartz-pr-gate[bot]',
      },
    });
  });

  it("never falls back to the actor's secrets when the gate's are missing", () => {
    expect(readServerConfig({ ...ACTOR_ENV, PR_APP_ROLE: 'gate' })).toEqual({
      kind: 'missing',
      names: ['PR_GATE_CLIENT_ID', 'PR_GATE_PRIVATE_KEY', 'PR_GATE_WEBHOOK_SECRET'],
    });
  });

  it('derives the gate bot login from its own slug variable', () => {
    expect(readServerConfig({ ...GATE_ENV, PR_GATE_APP_SLUG: 'gate-app' })).toMatchObject({
      config: { botLogin: 'gate-app[bot]' },
    });
  });
});

describe('readServerConfig: role', () => {
  it('reports a missing role by name, even with every secret present', () => {
    const env = { ...ACTOR_ENV, PR_APP_ROLE: undefined };
    expect(readServerConfig(env)).toEqual({ kind: 'missing', names: ['PR_APP_ROLE'] });
  });

  it('treats an unknown role as missing', () => {
    expect(readServerConfig({ ...ACTOR_ENV, PR_APP_ROLE: 'both' })).toEqual({
      kind: 'missing',
      names: ['PR_APP_ROLE'],
    });
  });
});
