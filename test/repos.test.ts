import { describe, expect, it } from 'vitest';
import type { RepoConfig } from '../src/repos.js';
import { toolConfig } from '../src/repos.js';

const POLICY = { uat: 'off', armAutoMerge: true } as const;

function makeRepos(
  prLifecycle?: NonNullable<RepoConfig['prLifecycle']>,
): Record<string, RepoConfig> {
  return { 'rmartz/pr-lifecycle': prLifecycle === undefined ? {} : { prLifecycle } };
}

describe('toolConfig: the reviewed allowlist (shelved)', () => {
  it('leaves pr-lifecycle off on the template', () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'prLifecycle')).toBeUndefined();
  });

  it('leaves pr-policy off on the template', () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'prPolicy')).toBeUndefined();
  });

  it('leaves merge-safety off on the template', () => {
    expect(toolConfig('rmartz/firebase-nextjs-template', 'mergeSafety')).toBeUndefined();
  });

  it('leaves pr-lifecycle off on group-picks', () => {
    expect(toolConfig('rmartz/group-picks', 'prLifecycle')).toBeUndefined();
  });

  it('leaves pr-policy off on group-picks', () => {
    expect(toolConfig('rmartz/group-picks', 'prPolicy')).toBeUndefined();
  });

  it('leaves merge-safety off on group-picks', () => {
    expect(toolConfig('rmartz/group-picks', 'mergeSafety')).toBeUndefined();
  });

  it('leaves every other repository disabled', () => {
    expect(toolConfig('rmartz/personal-budget', 'prLifecycle')).toBeUndefined();
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

  it('matches the repository name case-insensitively', () => {
    const repos = makeRepos({ mode: 'live', policy: POLICY });
    expect(toolConfig('RMartz/PR-Lifecycle', 'prLifecycle', repos)?.mode).toBe('live');
  });

  it('treats an off entry as not enabled', () => {
    const repos = makeRepos({ mode: 'off', policy: POLICY });
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', repos)).toBeUndefined();
  });

  it('treats a listed repo without an entry for the tool as not enabled', () => {
    expect(toolConfig('rmartz/pr-lifecycle', 'prLifecycle', makeRepos())).toBeUndefined();
  });
});
