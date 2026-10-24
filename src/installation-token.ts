import githubAppJwt from 'universal-github-app-jwt';

/** An installation token's permission grant, by GitHub permission name. */
export type TokenPermissions = Readonly<Record<string, 'read' | 'write'>>;

/**
 * The permissions a pr-lifecycle token is minted with: the same set
 * rmartz/pr-lifecycle-action asks `create-github-app-token` for, plus the reads
 * the action got from the workflow token, because here one token does everything.
 */
export const PR_LIFECYCLE_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  statuses: 'write',
  workflows: 'write',
  checks: 'read',
} as const satisfies TokenPermissions;

/**
 * The most a gate tool's token is minted with: its check-run and statuses, the
 * labels it owns, and read access to contents. Nothing merge-capable.
 */
export const GATE_PERMISSIONS = {
  checks: 'write',
  statuses: 'write',
  pull_requests: 'write',
  issues: 'write',
  contents: 'read',
} as const satisfies TokenPermissions;

export interface AppCredentials {
  /** The App's Client ID (a JWT issuer GitHub accepts in place of the App ID). */
  readonly clientId: string;
  /** The App's private key, PEM. */
  readonly privateKey: string;
}

export interface TokenMinterOptions extends AppCredentials {
  /** What every token this minter mints may do: one tool's explicit set. */
  readonly permissions: TokenPermissions;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  /** Signs the App JWT; tests inject one. */
  readonly sign?: (credentials: AppCredentials) => Promise<string>;
}

/** Mints a token for one installation, scoped to one of its repositories. */
export type MintToken = (installationId: number, repo: string) => Promise<string>;

async function signAppJwt(credentials: AppCredentials): Promise<string> {
  const { token } = await githubAppJwt({
    id: credentials.clientId,
    privateKey: credentials.privateKey,
  });
  return token;
}

/**
 * Builds a minter for installation access tokens with one tool's permissions.
 * Each token is scoped to the one repository the event is about
 * (`repositories: [repo]`), so a token minted for an event can never act on
 * another repository, even within the same installation.
 */
export function createTokenMinter(options: TokenMinterOptions): MintToken {
  const apiUrl = options.apiUrl ?? 'https://api.github.com';
  const doFetch = options.fetch ?? fetch;
  const sign = options.sign ?? signAppJwt;
  return async (installationId, repo) => {
    const jwt = await sign(options);
    const response = await doFetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ repositories: [repo], permissions: options.permissions }),
    });
    if (!response.ok) {
      throw new Error(
        `minting a token for installation ${installationId} failed: HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    const token =
      typeof body === 'object' && body !== null && 'token' in body ? body.token : undefined;
    if (typeof token !== 'string' || token === '') {
      throw new Error(`minting a token for installation ${installationId} returned no token`);
    }
    return token;
  };
}
