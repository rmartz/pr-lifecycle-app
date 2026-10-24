import { defineConfig } from 'vitest/config';

// Single-package repo: vitest globs the whole test tree, so there is no manual
// discovery list to fall out of sync with the files on disk.
//
// Coverage thresholds are enforced (CI runs `test:coverage`). The server decides
// which PR a webhook reconciles and with whose token, so an untested branch is a
// latent mis-merge; the bar starts high while the codebase is small. Lowering a
// threshold is a CI loosening and goes in its own PR (see AGENTS.md).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
