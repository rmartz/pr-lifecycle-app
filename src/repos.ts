import type { ReconcilePolicy } from '@rmartz/pr-lifecycle';

/**
 * How one tool treats one repository:
 * - `off`: the tool ignores the repo, as if it were unlisted.
 * - `shadow`: plan and log without writing. The repo still runs the tool's
 *   action, and the logged plans are compared against it before cutover.
 * - `live`: plan and write. The repo no longer runs the action.
 */
export type ToolMode = 'off' | 'shadow' | 'live';

/** A mode the tool acts in: everything but `off`. */
export type ActiveMode = Exclude<ToolMode, 'off'>;

/** One tool's settings for one repository: its mode, plus the tool's own policy. */
export interface ToolConfig<Policy> {
  readonly mode: ToolMode;
  readonly policy: Policy;
}

/** A tool's settings for a repo it acts on, so `off` can't reach a run. */
export interface ActiveToolConfig<Policy> {
  readonly mode: ActiveMode;
  readonly policy: Policy;
}

/** Each tool's policy type: the settings it takes besides its mode. */
export interface ToolPolicies {
  /** The reconciler: the same settings the action takes as inputs. */
  readonly prLifecycle: ReconcilePolicy;
}

export type ToolName = keyof ToolPolicies;

/** Each tool's settings for one repository. A tool left out is `off`. */
export type RepoConfig = { readonly [Tool in ToolName]?: ToolConfig<ToolPolicies[Tool]> };

/**
 * The repositories the App acts on, keyed by lowercased `owner/name`. The App is
 * installed on repos that still run the tools' actions, and a repo must never be
 * handled by both for one tool, so each tool ignores an installed repo unless it
 * is listed here with a mode other than `off`. Config lives in code so enabling
 * a repo is a reviewed change, never a file read from a PR head.
 */
export const REPOS: Readonly<Record<string, RepoConfig>> = {
  // The proof of concept (rmartz/pr-lifecycle#134). Matches the inputs the
  // template's retired pr-lifecycle.yml passed the action: UAT on, arming off.
  // Live: the template no longer runs the action.
  'rmartz/firebase-nextjs-template': {
    prLifecycle: { mode: 'live', policy: { uat: 'on', armAutoMerge: false } },
  },
};

/**
 * The settings `tool` acts on `owner/name` with, matched case-insensitively, or
 * undefined when the repo is unlisted or the tool is `off` there.
 */
export function toolConfig<Tool extends ToolName>(
  fullName: string,
  tool: Tool,
  repos: Readonly<Record<string, RepoConfig>> = REPOS,
): ActiveToolConfig<ToolPolicies[Tool]> | undefined {
  const entry = repos[fullName.toLowerCase()]?.[tool];
  if (entry === undefined) {
    return undefined;
  }
  const { mode, policy } = entry;
  return mode === 'off' ? undefined : { mode, policy };
}
