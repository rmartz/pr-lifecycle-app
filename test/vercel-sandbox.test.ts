import type { NetworkPolicyRule } from '@vercel/sandbox';
import { describe, expect, it } from 'vitest';
import type { SandboxCreateParams, SandboxVm } from '../src/vercel-sandbox.js';
import {
  createVercelSandboxOpener,
  githubFetchPolicy,
  SANDBOX_IMAGE,
  SANDBOX_SESSION_MS,
} from '../src/vercel-sandbox.js';

const TOKEN = 'ghs_installation_token';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

type Command = Parameters<SandboxVm['runCommand']>[0];

function makeVm(
  exitCode = 0,
): SandboxVm & { readonly commands: Command[]; readonly stops: number[] } {
  const commands: Command[] = [];
  const stops: number[] = [];
  return {
    commands,
    stops,
    runCommand(params) {
      commands.push(params);
      return Promise.resolve({
        exitCode,
        stdout: () => Promise.resolve('527a7449\n'),
        stderr: () => Promise.resolve('warning: x\n'),
      });
    },
    stop() {
      stops.push(1);
      return Promise.resolve();
    },
  };
}

function githubRules(): NetworkPolicyRule[] {
  const policy = githubFetchPolicy(TOKEN);
  if (typeof policy === 'string' || policy.allow === undefined || Array.isArray(policy.allow)) {
    throw new Error('expected a per-domain policy');
  }
  return policy.allow['github.com'] ?? [];
}

/** The rule a request would hit, mirroring the firewall's first-match evaluation. */
function ruleFor(method: string, path: string, service?: string): NetworkPolicyRule | undefined {
  return githubRules().find(({ match }) => {
    if (match === undefined) {
      return true;
    }
    const pattern = match.path !== undefined && 'regex' in match.path ? match.path.regex : '';
    const query = match.queryString?.[0]?.value;
    const wanted = query !== undefined && 'exact' in query ? query.exact : undefined;
    return (
      new RegExp(pattern ?? '').test(path) &&
      (match.method?.includes(method) ?? true) &&
      (wanted === undefined || wanted === service)
    );
  });
}

describe('githubFetchPolicy', () => {
  it('allows github.com and no other domain', () => {
    const policy = githubFetchPolicy(TOKEN);
    expect(typeof policy === 'object' ? Object.keys(policy.allow ?? {}) : policy).toEqual([
      'github.com',
    ]);
  });

  it('authenticates the ref advertisement for a fetch with the installation token', () => {
    const rule = ruleFor('GET', '/rmartz/repo.git/info/refs', 'git-upload-pack');
    expect(rule?.transform).toEqual([{ headers: { authorization: BASIC } }]);
  });

  it('authenticates the fetch itself with the installation token', () => {
    const rule = ruleFor('POST', '/rmartz/repo.git/git-upload-pack');
    expect(rule?.transform).toEqual([{ headers: { authorization: BASIC } }]);
  });

  it("refuses a push's ref advertisement without the token", () => {
    const rule = ruleFor('GET', '/rmartz/repo.git/info/refs', 'git-receive-pack');
    expect([rule?.response, rule?.transform]).toEqual([{ statusCode: 403 }, undefined]);
  });

  it('refuses a push without the token', () => {
    const rule = ruleFor('POST', '/rmartz/repo.git/git-receive-pack');
    expect([rule?.response, rule?.transform]).toEqual([{ statusCode: 403 }, undefined]);
  });

  it('refuses any other github.com request without the token', () => {
    const rule = ruleFor('GET', '/login');
    expect([rule?.response, rule?.transform]).toEqual([{ statusCode: 403 }, undefined]);
  });
});

describe('createVercelSandboxOpener', () => {
  it('boots a one-vCPU, non-persistent universal VM fenced by the fetch policy', async () => {
    const created: SandboxCreateParams[] = [];
    const open = createVercelSandboxOpener((params) => {
      created.push(params);
      return Promise.resolve(makeVm());
    });
    await open(TOKEN);
    expect(created).toEqual([
      {
        image: SANDBOX_IMAGE,
        resources: { vcpus: 1 },
        timeout: SANDBOX_SESSION_MS,
        persistent: false,
        networkPolicy: githubFetchPolicy(TOKEN),
      },
    ]);
  });

  it('runs git directly, never prompting, with the abort signal', async () => {
    const vm = makeVm();
    const sandbox = await createVercelSandboxOpener(() => Promise.resolve(vm))(TOKEN);
    const signal = new AbortController().signal;
    await sandbox.run(['merge-tree', '--write-tree'], signal);
    expect(vm.commands).toEqual([
      {
        cmd: 'git',
        args: ['merge-tree', '--write-tree'],
        env: { GIT_TERMINAL_PROMPT: '0' },
        signal,
      },
    ]);
  });

  it("maps the command's exit code and output to a git result", async () => {
    const sandbox = await createVercelSandboxOpener(() => Promise.resolve(makeVm(1)))(TOKEN);
    await expect(sandbox.run(['merge-tree'], new AbortController().signal)).resolves.toEqual({
      code: 1,
      stdout: '527a7449\n',
      stderr: 'warning: x\n',
    });
  });

  it('stops the VM', async () => {
    const vm = makeVm();
    const sandbox = await createVercelSandboxOpener(() => Promise.resolve(vm))(TOKEN);
    await sandbox.stop();
    expect(vm.stops).toHaveLength(1);
  });
});
