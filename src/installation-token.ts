import githubAppJwt from 'universal-github-app-jwt';

/**
 * The permissions each installation token is minted with: the same set
 * rmartz/pr-lifecycle-action asks `create-github-app-token` for, plus the reads
 * the action got from the workflow token, because here one token does everything.
 */
export const TOKEN_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  statuses: 'write',
  workflows: 'write',
  checks: 'read',
} as const;

export interface AppCredentials {
  /** The App's Client ID (a JWT issuer GitHub accepts in place of the App ID). */
  readonly clientId: string;
  /** The App's private key, PEM. */
  readonly privateKey: string;
}

export interface TokenMinterOptions extends AppCredentials {
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
 * Builds a minter for installation access tokens. Each token is scoped to the one
 * repository the event is about (`repositories: [repo]`), so a token minted for an
 * event can never act on another repository, even within the same installation.
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
      body: JSON.stringify({ repositories: [repo], permissions: TOKEN_PERMISSIONS }),
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
