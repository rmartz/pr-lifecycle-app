import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTokenMinter,
  GATE_PERMISSIONS,
  PR_LIFECYCLE_PERMISSIONS,
} from '../src/installation-token.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function fakeFetch(response: Response, captured: Captured[]): typeof fetch {
  return (input, init) => {
    captured.push({ url: urlOf(input), init });
    return Promise.resolve(response);
  };
}

const sign = () => Promise.resolve('signed-jwt');

describe('createTokenMinter', () => {
  it("posts to the event's own installation, scoped to the one repository", async () => {
    const captured: Captured[] = [];
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      privateKey: 'unused',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      sign,
      fetch: fakeFetch(Response.json({ token: 'ghs_minted' }, { status: 201 }), captured),
    });
    await mint(777, 'firebase-nextjs-template');
    expect(captured[0]?.url).toBe('https://api.github.com/app/installations/777/access_tokens');
    const body = captured[0]?.init?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({
      repositories: ['firebase-nextjs-template'],
      permissions: PR_LIFECYCLE_PERMISSIONS,
    });
  });

  it("asks for exactly the minter's permissions, so a gate token gets the gate set", async () => {
    const captured: Captured[] = [];
    const mint = createTokenMinter({
      clientId: 'Iv1.gate',
      privateKey: 'unused',
      permissions: GATE_PERMISSIONS,
      sign,
      fetch: fakeFetch(Response.json({ token: 'ghs_minted' }, { status: 201 }), captured),
    });
    await mint(888, 'repo');
    const body = captured[0]?.init?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '')).toMatchObject({
      permissions: {
        checks: 'write',
        statuses: 'write',
        pull_requests: 'write',
        issues: 'write',
        contents: 'read',
      },
    });
  });

  it('never grants a gate token a merge-capable permission', () => {
    expect(['workflows' in GATE_PERMISSIONS, GATE_PERMISSIONS.contents]).toEqual([false, 'read']);
  });

  it('authenticates with the App JWT', async () => {
    const captured: Captured[] = [];
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      privateKey: 'unused',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      sign,
      fetch: fakeFetch(Response.json({ token: 'ghs_minted' }, { status: 201 }), captured),
    });
    await mint(777, 'repo');
    expect(new Headers(captured[0]?.init?.headers).get('authorization')).toBe('Bearer signed-jwt');
  });

  it('returns the minted token', async () => {
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      privateKey: 'unused',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      sign,
      fetch: fakeFetch(Response.json({ token: 'ghs_minted' }, { status: 201 }), []),
    });
    await expect(mint(777, 'repo')).resolves.toBe('ghs_minted');
  });

  it('throws on an HTTP error, naming the status but not the response', async () => {
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      privateKey: 'unused',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      sign,
      fetch: fakeFetch(new Response('not installed', { status: 404 }), []),
    });
    await expect(mint(777, 'repo')).rejects.toThrow(
      'minting a token for installation 777 failed: HTTP 404',
    );
  });

  it('throws when the response carries no token', async () => {
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      privateKey: 'unused',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      sign,
      fetch: fakeFetch(Response.json({ expires_at: 'soon' }, { status: 201 }), []),
    });
    await expect(mint(777, 'repo')).rejects.toThrow('returned no token');
  });

  it('signs a real RS256 App JWT by default', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const captured: Captured[] = [];
    const mint = createTokenMinter({
      clientId: 'Iv1.client',
      permissions: PR_LIFECYCLE_PERMISSIONS,
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      fetch: fakeFetch(Response.json({ token: 'ghs_minted' }, { status: 201 }), captured),
    });
    await mint(777, 'repo');
    const jwt = new Headers(captured[0]?.init?.headers)
      .get('authorization')
      ?.slice('Bearer '.length);
    const claims = JSON.parse(Buffer.from(jwt?.split('.')[1] ?? '', 'base64url').toString()) as {
      iss: string;
    };
    expect(claims.iss).toBe('Iv1.client');
  });
});
