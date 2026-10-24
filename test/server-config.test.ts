import { describe, expect, it } from 'vitest';
import { readServerConfig } from '../src/server-config.js';

const ENV = {
  PR_LIFECYCLE_CLIENT_ID: 'Iv1.client',
  PR_LIFECYCLE_PRIVATE_KEY: '-----BEGIN KEY-----\\nabc\\n-----END KEY-----',
  PR_LIFECYCLE_WEBHOOK_SECRET: 'hook-secret',
};

describe('readServerConfig', () => {
  it('reads the secrets and unescapes the private key', () => {
    expect(readServerConfig(ENV)).toEqual({
      kind: 'ok',
      config: {
        clientId: 'Iv1.client',
        privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
        webhookSecret: 'hook-secret',
        botLogin: 'rmartz-pr-lifecycle[bot]',
      },
    });
  });

  it('derives the bot login from a configured slug', () => {
    expect(readServerConfig({ ...ENV, PR_LIFECYCLE_APP_SLUG: 'my-app' })).toMatchObject({
      config: { botLogin: 'my-app[bot]' },
    });
  });

  it('reports every missing or empty secret by name', () => {
    expect(
      readServerConfig({ PR_LIFECYCLE_CLIENT_ID: 'Iv1.client', PR_LIFECYCLE_WEBHOOK_SECRET: '' }),
    ).toEqual({
      kind: 'missing',
      names: ['PR_LIFECYCLE_PRIVATE_KEY', 'PR_LIFECYCLE_WEBHOOK_SECRET'],
    });
  });
});
