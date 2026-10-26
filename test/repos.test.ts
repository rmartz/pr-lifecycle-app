import { describe, expect, it } from 'vitest';
import type { RepoConfig } from '../src/repos.js';
import { toolConfig } from '../src/repos.js';

const POLICY = { uat: 'off', armAutoMerge: true } as const;

function makeRepos(
  prLifecycle?: NonNullable<RepoConfig['prLifecycle']>,
): Record<string, RepoConfig> {
  return { 'rmartz/pr-lifecycle': prLifecycle === undefined ? {} : { prLifecycle } };
}

describe('toolConfig: the reviewed allowlist', () => {
  it('reconciles the proof-of-concept repo live, with UAT on and arming off', () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'prLifecycle')).toEqual({
      mode: 'live',
      policy: { uat: 'on', armAutoMerge: false },
    });
  });

  it('matches the repository name case-insensitively', () => {
    expect(toolConfig('RMartz/Firebase-NextJS-Template', 'prLifecycle')?.mode).toBe('live');
  });

  it('leaves every other repository disabled', () => {
    expect(toolConfig('rmartz/personal-budget', 'prLifecycle')).toBeUndefined();
  });

  it("runs pr-policy live on the proof-of-concept repo with its workflow's inputs", () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'prPolicy')).toEqual({
      mode: 'live',
      policy: {
        skipUat: false,
        requireUatLabel: true,
        retitleDependabotCi: true,
        signOffStatusCreators: ['rmartz-pr-lifecycle[bot]'],
      },
    });
  });

  it('runs merge-safety live on the proof-of-concept repo with a bounded fan-out', () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'mergeSafety')).toEqual({
      mode: 'live',
      policy: { concurrency: 4 },
    });
  });

  it('shadows pr-lifecycle on group-picks with arming and auto-update on', () => {
    expect(toolConfig('rmartz/group-picks', 'prLifecycle')).toEqual({
      mode: 'shadow',
      policy: { uat: 'on', armAutoMerge: true, autoUpdate: true },
    });
  });

  it('leaves the gate tools off on group-picks', () => {
    expect(toolConfig('rmartz/group-picks', 'prPolicy')).toBeUndefined();
  });

  it('leaves pr-policy off on every other repository', () => {
    expect(toolConfig('rmartz/personal-budget', 'prPolicy')).toBeUndefined();
  });
});

describe('toolConfig: modes', () => {
  it('returns a shadow entry with its mode and policy', () => {
    const repos = makeRepos({ mode: 'shadow', policy: POLICY });
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', repos)).toEqual({
      mode: 'shadow',
      policy: POLICY,
    });
  });

  it('returns a live entry with its mode and policy', () => {
    const repos = makeRepos({ mode: 'live', policy: POLICY });
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', repos)).toEqual({
      mode: 'live',
      policy: POLICY,
    });
  });

  it('treats an off entry as not enabled', () => {
    const repos = makeRepos({ mode: 'off', policy: POLICY });
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', repos)).toBeUndefined();
  });

  it('treats a listed repo without an entry for the tool as not enabled', () => {
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', makeRepos())).toBeUndefined();
  });
});
