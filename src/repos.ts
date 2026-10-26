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

/**
 * pr-policy's settings for one repo: the inputs its caller workflow passed
 * `rmartz/pr-policy-action`. They live here, never in a file the PR could edit,
 * so a PR can't switch off the gate it is waiting on.
 */
export interface PrPolicyPolicy {
  /** Drop the UAT gate, for a repo with nothing to user-test. */
  readonly skipUat: boolean;
  /** Hold a PR that carries no UAT label. */
  readonly requireUatLabel: boolean;
  /** Retitle a Dependabot linter or formatter bump to `ci` before evaluating it. */
  readonly retitleDependabotCi: boolean;
  /** GitHub App logins trusted to post the `pr-lifecycle/sign-off` status. */
  readonly signOffStatusCreators: readonly string[];
}

/** merge-safety's settings for one repo. Its verdict takes no repo inputs. */
export interface MergeSafetyPolicy {
  /**
   * How many open PRs a base move re-evaluates at once. Bounds the fan-out's
   * share of the installation's rate limit and of the function's time.
   */
  readonly concurrency: number;
}

/** Each tool's policy type: the settings it takes besides its mode. */
export interface ToolPolicies {
  /** The reconciler: the same settings the action takes as inputs. */
  readonly prLifecycle: ReconcilePolicy;
  /** The pr-policy gate, posted by the gate role. */
  readonly prPolicy: PrPolicyPolicy;
  /** The merge-safety gate, posted by the gate role. */
  readonly mergeSafety: MergeSafetyPolicy;
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
    // The inputs the template's retired pr-policy.yml passed the action. Live:
    // the gate App posts the required `pr-policy` check.
    prPolicy: {
      mode: 'live',
      policy: {
        skipUat: false,
        requireUatLabel: true,
        retitleDependabotCi: true,
        signOffStatusCreators: ['rmartz-pr-lifecycle[bot]'],
      },
    },
    // Live: the gate App posts the required `merge-safety` check, replacing the
    // template's retired merge-safety.yml.
    mergeSafety: { mode: 'live', policy: { concurrency: 4 } },
  },
  // The first repo with arming on: the inputs group-picks' pr-lifecycle.yml
  // passes the action. Shadow: the action still writes; the App only logs plans.
  'rmartz/group-picks': {
    prLifecycle: {
      mode: 'shadow',
      policy: { uat: 'on', armAutoMerge: true, autoUpdate: true },
    },
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
