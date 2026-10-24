import type { GitResult, GitRunner } from '@rmartz/pr-lifecycle';

/** One running sandbox VM that can run git. */
export interface GitSandbox {
  /** Runs `git` with `args` in the VM; resolves whatever the exit code. */
  run(args: readonly string[], signal: AbortSignal): Promise<GitResult>;
  stop(): Promise<void>;
}

/**
 * Boots a sandbox whose egress reaches only GitHub, with `token` injected by the
 * sandbox's firewall rather than placed in the VM.
 */
export type OpenGitSandbox = (token: string) => Promise<GitSandbox>;

/** A git runner for one reconcile run, and the cleanup that ends it. */
export interface SandboxGit {
  readonly git: GitRunner;
  /**
   * Stops the sandbox, if one was booted. Never rejects: resolves the reason when
   * stopping failed, else undefined.
   */
  close(): Promise<string | undefined>;
}

export interface SandboxGitOptions {
  /** How long one git command, including the boot before the first, may take. */
  readonly commandTimeoutMs: number;
}

/**
 * A `GitRunner` backed by a sandbox VM, for the library's approval carry-over
 * (`lineage`). The VM boots on the first git call, so a reconcile that has no
 * earlier-commit review to verify never creates one.
 *
 * It fails closed: a boot failure, a capacity or quota limit, a command error or
 * a timeout rejects the call, and every later call rejects too, without retrying.
 * The library turns a rejection into "no carry-over", so an earlier approval stops
 * counting; it never counts one it couldn't verify.
 *
 * The library passes the fetch token as git config in `env`. That env is never
 * forwarded: the token reaches GitHub through the sandbox's firewall instead, so
 * the VM never holds it.
 */
export function createSandboxGit(
  token: string,
  open: OpenGitSandbox,
  options: SandboxGitOptions,
): SandboxGit {
  let sandbox: Promise<GitSandbox> | undefined;
  let failure: Error | undefined;

  async function runOnce(args: readonly string[]): Promise<GitResult> {
    const controller = new AbortController();
    const work = async (): Promise<GitResult> => {
      sandbox ??= open(token);
      return (await sandbox).run(args, controller.signal);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${options.commandTimeoutMs} ms`));
      }, options.commandTimeoutMs);
    });
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    git: {
      async run(args) {
        if (failure !== undefined) {
          throw failure;
        }
        try {
          return await runOnce(args);
        } catch (error) {
          failure = new Error(`git ${args[0] ?? ''} in the sandbox failed: ${describe(error)}`, {
            cause: error,
          });
          throw failure;
        }
      },
    },
    async close() {
      if (sandbox === undefined) {
        return undefined;
      }
      let booted: GitSandbox;
      try {
        // Waits out a boot still in flight, so a VM that comes up late is stopped too.
        booted = await sandbox;
      } catch {
        return undefined;
      }
      try {
        await booted.stop();
        return undefined;
      } catch (error) {
        return describe(error);
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
