import type { ReconcilePolicy } from '@rmartz/pr-lifecycle';

/** How the App reconciles one repository. */
export interface RepoConfig {
  /** The reconciler policy: the same settings the action takes as inputs. */
  readonly policy: ReconcilePolicy;
  /**
   * Plan and log without writing anything. Shadow mode: the repo still runs the
   * action, and the App's logged plans are compared against it before cutover.
   */
  readonly dryRun: boolean;
}

/**
 * The repositories the App acts on, keyed by lowercased `owner/name`. The App is
 * installed on repos that still run `rmartz/pr-lifecycle-action`, and a repo must
 * never be reconciled by both, so an installed repo is ignored unless it is listed
 * here. Config lives in code so enabling a repo is a reviewed change.
 */
export const REPOS: Readonly<Record<string, RepoConfig>> = {
  // The proof of concept (rmartz/pr-lifecycle#134). Matches the template's
  // pr-lifecycle.yml inputs: UAT on, arming off.
  'rmartz/firebase-nextjs-template': {
    policy: { uat: 'on', armAutoMerge: false },
    dryRun: true,
  },
};

/** The config for `owner/name`, matched case-insensitively, or undefined if not enabled. */
export function repoConfig(
  fullName: string,
  repos: Readonly<Record<string, RepoConfig>> = REPOS,
): RepoConfig | undefined {
  return repos[fullName.toLowerCase()];
}
