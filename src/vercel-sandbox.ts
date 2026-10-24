import type { GitResult } from '@rmartz/pr-lifecycle';
import type { NetworkPolicy } from '@vercel/sandbox';
import { Sandbox } from '@vercel/sandbox';
import type { GitSandbox, OpenGitSandbox } from './sandbox-git.js';

/** The managed image with git ≥ 2.40 (the minimal `ubuntu` image has no git). */
export const SANDBOX_IMAGE = 'vercel/sandbox/universal';

/**
 * The VM's own lifetime: the function's 300 s ceiling. The runner stops it when
 * the reconcile ends; this only bounds a VM orphaned by a killed function.
 */
export const SANDBOX_SESSION_MS = 300_000;

/** A repository path on github.com: `/owner/name` or `/owner/name.git`. */
const REPO_PATH = String.raw`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`;

/**
 * Egress for a carry-over check: github.com only, and on it only git's fetch
 * (upload-pack) endpoints, which the firewall authenticates with `token`. Any
 * other request there, a push included, is answered 403 by the firewall without
 * the token ever leaving it, so the token's write scope is unreachable from the
 * VM. Every other domain is denied.
 */
export function githubFetchPolicy(token: string): NetworkPolicy {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const transform = [{ headers: { authorization: `Basic ${basic}` } }];
  return {
    allow: {
      'github.com': [
        {
          match: {
            path: { regex: `${REPO_PATH}/info/refs$` },
            method: ['GET'],
            queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
          },
          transform,
        },
        {
          match: { path: { regex: `${REPO_PATH}/git-upload-pack$` }, method: ['POST'] },
          transform,
        },
        { response: { statusCode: 403 } },
      ],
    },
  };
}

/** The slice of a booted `@vercel/sandbox` VM the runner uses. */
export interface SandboxVm {
  runCommand(params: {
    cmd: string;
    args: string[];
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  stop(): Promise<unknown>;
}

// A type alias, not an interface: the SDK's params carry an index signature,
// which only an alias satisfies structurally.
export type SandboxCreateParams = {
  readonly image: string;
  readonly resources: { vcpus: number };
  readonly timeout: number;
  readonly persistent: boolean;
  readonly networkPolicy: NetworkPolicy;
};

export type CreateSandboxVm = (params: SandboxCreateParams) => Promise<SandboxVm>;

/**
 * Opens one Vercel Sandbox VM per reconcile run: one vCPU, non-persistent (no
 * snapshot is kept), egress per `githubFetchPolicy`. On Vercel the SDK
 * authenticates with the deployment's OIDC token.
 */
export function createVercelSandboxOpener(
  create: CreateSandboxVm = (params) => Sandbox.create(params),
): OpenGitSandbox {
  return async (token) => {
    const vm = await create({
      image: SANDBOX_IMAGE,
      resources: { vcpus: 1 },
      timeout: SANDBOX_SESSION_MS,
      persistent: false,
      networkPolicy: githubFetchPolicy(token),
    });
    return wrap(vm);
  };
}

function wrap(vm: SandboxVm): GitSandbox {
  return {
    async run(args, signal): Promise<GitResult> {
      const finished = await vm.runCommand({
        cmd: 'git',
        args: [...args],
        // Never prompt for credentials; fail instead (as the library's own runner).
        env: { GIT_TERMINAL_PROMPT: '0' },
        signal,
      });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      return { code: finished.exitCode, stdout, stderr };
    },
    async stop() {
      await vm.stop();
    },
  };
}
