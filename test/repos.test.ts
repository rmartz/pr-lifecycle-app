import { describe, expect, it } from 'vitest';
import { repoConfig } from '../src/repos.js';

describe('repoConfig', () => {
  it('runs the proof-of-concept repo in shadow mode with UAT on and arming off', () => {
    expect(repoConfig('rmartz/firebase-nextjs-template')).toEqual({
      policy: { uat: 'on', armAutoMerge: false },
      dryRun: true,
    });
  });

  it('matches the repository name case-insensitively', () => {
    expect(repoConfig('RMartz/Firebase-NextJS-Template')).toBeDefined();
  });

  it('leaves every other repository disabled', () => {
    expect(repoConfig('rmartz/personal-budget')).toBeUndefined();
  });
});
