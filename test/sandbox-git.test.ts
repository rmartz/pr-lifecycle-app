import type { GitResult } from '@rmartz/pr-lifecycle';
import { describe, expect, it } from 'vitest';
import type { GitSandbox, OpenGitSandbox } from '../src/sandbox-git.js';
import { createSandboxGit } from '../src/sandbox-git.js';

const TOKEN = 'ghs_installation_token';
const OPTIONS = { commandTimeoutMs: 1_000 };
const RESULT: GitResult = { code: 0, stdout: 'git version 2.53.0\n', stderr: '' };

interface FakeSandbox extends GitSandbox {
  readonly runs: { args: readonly string[]; signal: AbortSignal }[];
  stops: number;
}

function makeSandbox(
  run: (args: readonly string[]) => Promise<GitResult> = () => Promise.resolve(RESULT),
  stop: () => Promise<void> = () => Promise.resolve(),
): FakeSandbox {
  const sandbox: FakeSandbox = {
    runs: [],
    stops: 0,
    run(args, signal) {
      sandbox.runs.push({ args, signal });
      return run(args);
    },
    stop() {
      sandbox.stops += 1;
      return stop();
    },
  };
  return sandbox;
}

function makeOpener(open: () => Promise<GitSandbox>): OpenGitSandbox & { tokens: string[] } {
  const tokens: string[] = [];
  return Object.assign(
    (token: string) => {
      tokens.push(token);
      return open();
    },
    { tokens },
  );
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('createSandboxGit: boots lazily, once', () => {
  it('opens no sandbox until the first git call', async () => {
    const open = makeOpener(() => Promise.resolve(makeSandbox()));
    await createSandboxGit(TOKEN, open, OPTIONS).close();
    expect(open.tokens).toEqual([]);
  });

  it("opens the sandbox with the run's token on the first call", async () => {
    const open = makeOpener(() => Promise.resolve(makeSandbox()));
    await createSandboxGit(TOKEN, open, OPTIONS).git.run(['version']);
    expect(open.tokens).toEqual([TOKEN]);
  });

  it('runs every call in the one sandbox', async () => {
    const sandbox = makeSandbox();
    const open = makeOpener(() => Promise.resolve(sandbox));
    const { git } = createSandboxGit(TOKEN, open, OPTIONS);
    await git.run(['version']);
    await git.run(['init', '--bare', '--quiet', '/tmp/lineage']);
    expect([open.tokens.length, sandbox.runs.map(({ args }) => args[0])]).toEqual([
      1,
      ['version', 'init'],
    ]);
  });

  it("returns the sandbox's result, a non-zero exit included", async () => {
    const failed: GitResult = { code: 1, stdout: '', stderr: 'CONFLICT' };
    const open = makeOpener(() => Promise.resolve(makeSandbox(() => Promise.resolve(failed))));
    await expect(createSandboxGit(TOKEN, open, OPTIONS).git.run(['merge-tree'])).resolves.toEqual(
      failed,
    );
  });
});

describe('createSandboxGit: the token stays out of the VM', () => {
  it('never forwards the env the library passes, which carries the token', async () => {
    const sandbox = makeSandbox();
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await git.run(['fetch', 'https://github.com/o/r'], { GIT_CONFIG_VALUE_0: `basic ${TOKEN}` });
    expect(JSON.stringify(sandbox.runs.map(({ args }) => args))).not.toContain(TOKEN);
  });
});

describe('createSandboxGit: fails closed', () => {
  it('rejects when the sandbox cannot boot', async () => {
    const open = makeOpener(() => Promise.reject(new Error('sandbox quota exceeded')));
    await expect(createSandboxGit(TOKEN, open, OPTIONS).git.run(['version'])).rejects.toThrow(
      'git version in the sandbox failed: sandbox quota exceeded',
    );
  });

  it('names the subcommand past --git-dir when a command fails', async () => {
    const sandbox = makeSandbox(() => Promise.reject(new Error('session stopped')));
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await expect(git.run(['--git-dir', '/tmp/lineage', 'fetch', '--quiet'])).rejects.toThrow(
      'git fetch in the sandbox failed: session stopped',
    );
  });

  it('rejects when a command errors', async () => {
    const sandbox = makeSandbox(() => Promise.reject(new Error('session stopped')));
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await expect(git.run(['fetch'])).rejects.toThrow('session stopped');
  });

  it('rejects a command that outlives the timeout', async () => {
    const sandbox = makeSandbox(() => never());
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      {
        commandTimeoutMs: 5,
      },
    );
    await expect(git.run(['fetch'])).rejects.toThrow('timed out after 5 ms');
  });

  it('aborts the timed-out command', async () => {
    const sandbox = makeSandbox(() => never());
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      {
        commandTimeoutMs: 5,
      },
    );
    await git.run(['fetch']).catch(() => undefined);
    expect(sandbox.runs[0]?.signal.aborted).toBe(true);
  });

  it('rejects a boot that outlives the timeout', async () => {
    const open = makeOpener(() => never());
    const { git } = createSandboxGit(TOKEN, open, { commandTimeoutMs: 5 });
    await expect(git.run(['version'])).rejects.toThrow('timed out after 5 ms');
  });

  it('rejects every later call without retrying the boot', async () => {
    const open = makeOpener(() => Promise.reject(new Error('concurrency limit')));
    const { git } = createSandboxGit(TOKEN, open, OPTIONS);
    await git.run(['version']).catch(() => undefined);
    await expect(git.run(['init'])).rejects.toThrow('concurrency limit');
    expect(open.tokens).toHaveLength(1);
  });

  it('rejects every later call after a command fails, without running it', async () => {
    let calls = 0;
    const sandbox = makeSandbox(() =>
      calls++ === 0 ? Promise.reject(new Error('lost')) : Promise.resolve(RESULT),
    );
    const { git } = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await git.run(['fetch']).catch(() => undefined);
    await expect(git.run(['merge-tree'])).rejects.toThrow('lost');
    expect(sandbox.runs).toHaveLength(1);
  });
});

describe('createSandboxGit: close', () => {
  it('stops the booted sandbox', async () => {
    const sandbox = makeSandbox();
    const sandboxGit = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await sandboxGit.git.run(['version']);
    await sandboxGit.close();
    expect(sandbox.stops).toBe(1);
  });

  it('resolves nothing when the sandbox never booted', async () => {
    const sandboxGit = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.reject(new Error('no capacity'))),
      OPTIONS,
    );
    await sandboxGit.git.run(['version']).catch(() => undefined);
    await expect(sandboxGit.close()).resolves.toBeUndefined();
  });

  it('stops a sandbox whose boot finished after its command timed out', async () => {
    const sandbox = makeSandbox();
    let finishBoot: (booted: GitSandbox) => void = () => undefined;
    const booting = new Promise<GitSandbox>((resolve) => {
      finishBoot = resolve;
    });
    const sandboxGit = createSandboxGit(
      TOKEN,
      makeOpener(() => booting),
      { commandTimeoutMs: 5 },
    );
    await sandboxGit.git.run(['version']).catch(() => undefined);
    finishBoot(sandbox);
    await sandboxGit.close();
    expect(sandbox.stops).toBe(1);
  });

  it('resolves the reason when stopping fails, instead of rejecting', async () => {
    const sandbox = makeSandbox(undefined, () => Promise.reject(new Error('stop failed')));
    const sandboxGit = createSandboxGit(
      TOKEN,
      makeOpener(() => Promise.resolve(sandbox)),
      OPTIONS,
    );
    await sandboxGit.git.run(['version']);
    await expect(sandboxGit.close()).resolves.toBe('stop failed');
  });
});
