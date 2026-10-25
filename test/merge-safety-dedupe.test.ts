import { describe, expect, it } from 'vitest';
import { baseKey, branchTip, isCurrentVerdict } from '../src/merge-safety-dedupe.js';
import { memoizeReads } from '../src/memo-client.js';
import { makeFakeClient } from './fake-client.js';
import { REPO } from './merge-safety-fixtures.js';

function makeBase(runs: { name: string; conclusion: string | null }[], required = ['Test']) {
  return makeFakeClient({
    [`repos/${REPO}/branches/main`]: { commit: { sha: 'tip1' } },
    [`repos/${REPO}/rules/branches/main`]: [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: required.map((context) => ({ context })) },
      },
    ],
    [`repos/${REPO}/commits/tip1/check-runs?filter=latest`]: {
      check_runs: runs.map((run) => ({ ...run, app: null })),
    },
  });
}

describe('baseKey', () => {
  it('starts with the base tip', async () => {
    expect(await baseKey(makeBase([]), REPO, 'main')).toMatch(/^tip1:[0-9a-f]{12}$/);
  });

  it('changes when a required check fails', async () => {
    const before = await baseKey(makeBase([{ name: 'Test', conclusion: null }]), REPO, 'main');
    const after = await baseKey(makeBase([{ name: 'Test', conclusion: 'failure' }]), REPO, 'main');
    expect(after).not.toBe(before);
  });

  it("doesn't change when a required check turns green, which can't change a verdict", async () => {
    const before = await baseKey(makeBase([{ name: 'Test', conclusion: null }]), REPO, 'main');
    const after = await baseKey(makeBase([{ name: 'Test', conclusion: 'success' }]), REPO, 'main');
    expect(after).toBe(before);
  });

  it("doesn't change when a non-required check concludes", async () => {
    const before = await baseKey(makeBase([{ name: 'Lint', conclusion: null }]), REPO, 'main');
    const after = await baseKey(makeBase([{ name: 'Lint', conclusion: 'success' }]), REPO, 'main');
    expect(after).toBe(before);
  });

  it('is undefined when the tip cannot be read', async () => {
    expect(await baseKey(makeFakeClient(), REPO, 'main')).toBeUndefined();
  });
});

describe('branchTip', () => {
  it('reads the branch head', async () => {
    expect(await branchTip(makeBase([]), REPO, 'main')).toBe('tip1');
  });
});

describe('isCurrentVerdict', () => {
  const path = `repos/${REPO}/commits/h1/check-runs?check_name=merge-safety%20(app)&filter=latest`;
  const verdict = (run: unknown) =>
    isCurrentVerdict(
      makeFakeClient({ [path]: { check_runs: [run] } }),
      REPO,
      'h1',
      'merge-safety (app)',
      'k1',
    );

  it('is true for a completed run computed against the key', async () => {
    expect(await verdict({ status: 'completed', external_id: 'k1' })).toBe(true);
  });

  it('is false for a run against another key', async () => {
    expect(await verdict({ status: 'completed', external_id: 'k0' })).toBe(false);
  });

  it('is false for a pending run', async () => {
    expect(await verdict({ status: 'in_progress', external_id: 'k1' })).toBe(false);
  });

  it('is false when no run exists or it cannot be read', async () => {
    expect(await isCurrentVerdict(makeFakeClient(), REPO, 'h1', 'merge-safety (app)', 'k1')).toBe(
      false,
    );
  });
});

describe('memoizeReads', () => {
  it('reads a shared resource once', async () => {
    const client = makeFakeClient({ 'repos/o/r/branches/main': { commit: { sha: 't' } } });
    const memo = memoizeReads(client);
    await memo.getJson('repos/o/r/branches/main');
    await memo.getJson('repos/o/r/branches/main');
    expect(client.reads).toEqual(['repos/o/r/branches/main']);
  });

  it('always re-reads a PR, whose mergeability it waits on', async () => {
    const client = makeFakeClient({ 'repos/o/r/pulls/3': { number: 3 } });
    const memo = memoizeReads(client);
    await memo.getJson('repos/o/r/pulls/3');
    await memo.getJson('repos/o/r/pulls/3');
    expect(client.reads).toHaveLength(2);
  });

  it('always re-reads check-runs by name, which the run itself changes', async () => {
    const path = 'repos/o/r/commits/h/check-runs?check_name=x&filter=all';
    const client = makeFakeClient({ [path]: { check_runs: [] } });
    const memo = memoizeReads(client);
    await memo.list(path, 'check_runs');
    await memo.list(path, 'check_runs');
    expect(client.reads).toHaveLength(2);
  });

  it("doesn't keep a failed read, so it is retried", async () => {
    const client = makeFakeClient();
    const memo = memoizeReads(client);
    await memo.getRaw('repos/o/r/contents/a');
    await Promise.resolve();
    await memo.getRaw('repos/o/r/contents/a');
    expect(client.reads).toHaveLength(2);
  });

  it('passes writes through', async () => {
    const client = makeFakeClient();
    const memo = memoizeReads(client);
    await memo.send('POST', 'repos/o/r/statuses/s', { state: 'success' });
    await memo.addLabels('o/r', 1, ['a']);
    await memo.removeLabel('o/r', 1, 'a');
    expect(client.writes).toHaveLength(3);
  });
});
