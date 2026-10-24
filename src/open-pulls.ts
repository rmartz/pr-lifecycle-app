/** Looks up the open PRs into `owner/repo` whose head is `sha`. */
export type FindOpenPulls = (
  token: string,
  owner: string,
  repo: string,
  sha: string,
) => Promise<number[]>;

export interface OpenPullsOptions {
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
}

interface RestPullSummary {
  readonly number: number;
  readonly state: string;
  readonly base: { readonly repo: { readonly full_name: string } };
}

/**
 * The open PRs for a CI run's head commit, when the run's payload lists none (fork
 * PRs). Mirrors the action's `gh api repos/{repo}/commits/{sha}/pulls` fallback,
 * keeping only open PRs whose base is this repository. One page of 100 is enough:
 * a single commit is the head of very few PRs.
 */
export function createOpenPullsFinder(options: OpenPullsOptions = {}): FindOpenPulls {
  const apiUrl = options.apiUrl ?? 'https://api.github.com';
  const doFetch = options.fetch ?? fetch;
  return async (token, owner, repo, sha) => {
    const response = await doFetch(
      `${apiUrl}/repos/${owner}/${repo}/commits/${sha}/pulls?per_page=100`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `looking up the PRs for ${owner}/${repo}@${sha} failed: HTTP ${response.status}`,
      );
    }
    const pulls = (await response.json()) as readonly RestPullSummary[];
    const fullName = `${owner}/${repo}`.toLowerCase();
    return pulls
      .filter(
        (pull) => pull.state === 'open' && pull.base.repo.full_name.toLowerCase() === fullName,
      )
      .map((pull) => pull.number);
  };
}
