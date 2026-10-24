import type { MergeSafetyConfig } from '../src/merge-safety-evaluate.js';

export const REPO = 'rmartz/firebase-nextjs-template';

export const MS_SHADOW: MergeSafetyConfig = { mode: 'shadow', policy: { concurrency: 2 } };
export const MS_LIVE: MergeSafetyConfig = { ...MS_SHADOW, mode: 'live' };

export interface PullOverrides {
  readonly mergeable?: boolean | null;
  readonly state?: string;
  readonly merged?: boolean;
  readonly head?: string;
  readonly title?: string;
}

export function makePull(overrides: PullOverrides = {}) {
  return {
    state: overrides.state ?? 'open',
    merged: overrides.merged ?? false,
    title: overrides.title ?? 'feat: add a thing',
    head: { sha: overrides.head ?? 'head1' },
    base: { ref: 'main' },
    labels: [{ name: 'no UAT needed' }],
    mergeable: overrides.mergeable === undefined ? true : overrides.mergeable,
  };
}

/**
 * The raw API responses merge-safety reads for one PR (`head`) against a base
 * whose tip is `tip`. `current` puts the PR's merge base at the tip; otherwise
 * the base has moved by one commit.
 */
export function makeMergeSafetyRoutes(
  options: { pr?: number; head?: string; tip?: string; current?: boolean } = {},
): Record<string, unknown> {
  const pr = options.pr ?? 31;
  const head = options.head ?? 'head1';
  const tip = options.tip ?? 'tip1';
  const mergeBase = options.current === false ? 'old1' : tip;
  const moved = options.current === false;
  return {
    [`repos/${REPO}/pulls/${pr}`]: makePull({ head }),
    [`repos/${REPO}/branches/main`]: { commit: { sha: tip } },
    [`repos/${REPO}/compare/${head}...${tip}`]: {
      merge_base_commit: { sha: mergeBase },
      total_commits: moved ? 1 : 0,
      commits: moved
        ? [{ sha: tip, commit: { message: 'docs: tweak' }, parents: [{ sha: 'x' }] }]
        : [],
      ...(moved ? { files: [{ filename: 'README.md', changes: 1 }] } : {}),
    },
    [`repos/${REPO}/compare/${tip}...${head}`]: {
      merge_base_commit: { sha: mergeBase },
      total_commits: 1,
      commits: [{ sha: head, commit: { message: 'feat: add a thing' } }],
      files: [{ filename: 'src/a.ts', changes: 2, patch: '@@ -1 +1 @@\n-a\n+b' }],
    },
    [`repos/${REPO}/commits/${tip}`]: { files: [{ filename: 'README.md' }] },
    [`repos/${REPO}/commits/${tip}/check-runs?filter=latest`]: { check_runs: [] },
    [`repos/${REPO}/rules/branches/main`]: [],
    [`repos/${REPO}/commits/${head}/check-runs?check_name=merge-safety%20(app)&filter=all`]: {
      check_runs: [],
    },
    [`repos/${REPO}/commits/${head}/check-runs?check_name=merge-safety&filter=all`]: {
      check_runs: [],
    },
  };
}
