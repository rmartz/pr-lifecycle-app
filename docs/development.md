---
type: Reference
title: Development and CI
description: The pr-lifecycle-app toolchain and commands, each CI workflow and what it gates, repo hygiene and the pre-commit hook, Dependabot, and where deploy automation will go.
tags: [ci, tooling, dependabot, deploy, conventions]
---

# Development and CI

## Toolchain

| Concern  | Tool                                                                  |
| -------- | --------------------------------------------------------------------- |
| Language | TypeScript 6, strict (`tsconfig.json` type-checks `src/` and `test/`) |
| Build    | `tsc` → ESM in `dist/` (`tsconfig.build.json`)                        |
| Lint     | ESLint flat config, type-aware (`eslint.config.mjs`)                  |
| Format   | Prettier (`.prettierrc.json`)                                         |
| Test     | Vitest + v8 coverage with enforced thresholds                         |
| Packages | pnpm (version pinned by `packageManager`)                             |
| Hygiene  | `@rmartz/repo-hygiene` (CI action + pre-commit hook)                  |

Node 24 runs CI and is the runtime the service targets (`engines`). The build is a
plain `tsc` emit for now; whether the deploy target wants a bundle is part of the
open hosting decision in
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134).

This is a deployed service, not a published package, so it is `private` and every
dependency is pinned **exactly** (`3.9.10`, no caret): each version change arrives
as its own reviewed Dependabot PR instead of slipping in through a lockfile
regeneration.

## Commands

```bash
pnpm install             # first, in every worktree; no token needed
pnpm run build           # tsc → dist
pnpm run typecheck       # tsc --noEmit over src/ and test/
pnpm run lint            # eslint, type-aware (incl. max-lines caps)
pnpm run format:check    # prettier --check
pnpm run test            # vitest
pnpm run test:coverage   # vitest + enforced coverage thresholds (what CI runs)
pnpm run hygiene         # every repo-hygiene check (the pre-commit hook runs --staged)
```

Every dependency, `@rmartz/*` included, installs from npmjs. The repo-root
[`.npmrc`](../.npmrc) pins the `@rmartz` scope to npmjs as well, so a developer's
global GitHub Packages mapping can't reroute it.

## CI workflows

| Workflow           | Trigger                     | Gates                                                                                                |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ci.yml`           | PR + push to `main`         | Typecheck, Lint, Format, Build, Test (with coverage)                                                 |
| `repo-hygiene.yml` | PR + push to `main`         | `hygiene`: every repo-hygiene check, configured in `.repo-hygiene.yml`                               |
| `merge-safety.yml` | `pull_request_target`, push | the `merge-safety` check-run (base currency, conflicts)                                              |
| `pr-policy.yml`    | `pull_request_target`       | the `pr-policy` check (title rules, CI sign-off), with `skip-uat: true`                              |
| `pr-lifecycle.yml` | PR, review, CI completion   | runs the reconciler through `rmartz/pr-lifecycle-action`: lifecycle labels, auto-merge on `approved` |

Every job has a timeout; a hit is a signal to investigate, not a number to raise.
The default-branch ruleset should require the CI jobs, `hygiene`, `merge-safety`
and `pr-policy`. A change that loosens CI (removing a job, `continue-on-error`,
lowering a coverage threshold, raising a timeout, a hygiene `severity` override)
lands alone in its own `ci:` PR.

`pr-lifecycle.yml` dogfoods the reconciler through the action until this App can
serve the repo itself. A repo must never run both, so the switch deletes that
workflow in the same change that installs the App here.

There is no release workflow and no post-merge commit-convention tripwire: the
service publishes no package, so nothing consumes a conventional subject on
`main`. PR titles are still Conventional Commits, checked by pr-policy.

## Deploy

Deploy automation does not exist yet; it waits on the hosting choice in
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134).
When it lands:

- It goes in `.github/workflows/deploy.yml`, triggered by push to `main` (and
  `workflow_dispatch` for a redeploy), never on `pull_request`.
- The App's private key and webhook secret live in the host's secret store, never
  in this repository or its Actions logs. `.gitignore` already excludes `.env*`
  and `*.pem`.
- Document the workflow, its secrets, and how to roll back here and in the
  table above.

## Repo hygiene

[`.repo-hygiene.yml`](../.repo-hygiene.yml) sets options only; every check runs at
the severity repo-hygiene ships. The same checks run in two places:

- **Pre-commit:** `.husky/pre-commit` runs `pnpm run hygiene:staged` over staged
  content (installed by the `prepare` script on `pnpm install`).
- **CI:** the Repo Hygiene workflow, via the SHA-pinned
  `rmartz/repo-hygiene-action`. It omits the action's `checks` input, so a new
  default-on check joins automatically on the next pin bump.

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) updates npm and GitHub
Actions weekly. Production npm deps use the `fix` prefix, dev deps and Actions
use `chore`. ESLint and Prettier, with their plugin families, share one `ci`
group (pr-policy retitles it to `ci(deps…)`); TypeScript gets its own PR. Other
patch and minor bumps are batched per dependency type for npm and in one group
for Actions, so the reconciler can approve and arm them as eligible bot PRs.
Every major gets its own PR for review.
