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

Node 24 runs CI and is the runtime the service targets (`engines`). The `tsc`
build is CI's compile check. Vercel compiles the function in `api/` itself, along
with the `src/` modules it imports.

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
workflow in the same change that adds this repo to [`src/repos.ts`](../src/repos.ts).

There is no release workflow and no post-merge commit-convention tripwire: the
service publishes no package, so nothing consumes a conventional subject on
`main`. PR titles are still Conventional Commits, checked by pr-policy.

## Deploy

The server is a Vercel project deployed by **Vercel's Git integration**, so there
is no deploy workflow here:

- **Production only.** [`vercel.json`](../vercel.json) sets
  `git.deploymentEnabled` to `main` only, so a push to `main` deploys and branch
  pushes build no preview. A preview would be useless anyway: the App's webhook
  points at production. Testing a branch end to end would need a second dev App
  aimed at a preview URL.
- **Project and build.** The project is `pr-lifecycle-app` on the
  `reed-8753s-projects` team, served at `https://pr-lifecycle-app.vercel.app`.
  The build runs `pnpm run build` as a compile check. The static output is
  `public/`, which holds only a deny-all [`robots.txt`](../public/robots.txt). Without an
  explicit output directory, Vercel would serve the repo root as static files.
  Locally, `vercel link` writes `.vercel/`, which is gitignored.
- **Function limits.** `api/webhook.ts` gets `maxDuration: 300`, room for the
  30-second settle wait plus fact-gathering. The webhook itself is acknowledged
  first; see [The webhook server](server.md#a-delivery-step-by-step).
- **Secrets.** The App's Client ID, private key and webhook secret are Vercel
  environment variables, set in the **Production** environment only (names in
  [The webhook server](server.md#environment)). Never commit them, and never put
  them in Actions logs. `.gitignore` already excludes `.env*` and `*.pem`.
- **Rollback.** Promote the previous production deployment in Vercel
  (`vercel rollback`, or Instant Rollback in the dashboard), then revert on
  `main`. To stop the App acting on a repo immediately, remove it from
  [`src/repos.ts`](../src/repos.ts), or clear the App's webhook URL.

## Secrets and env vars (envctl)

The Vercel project `pr-lifecycle-app` reads three env vars, all on the
**Production** target only. [`deployment/`](../deployment/manifest.yml) declares
them for [envctl](https://github.com/rmartz/envctl)'s `github-app` provider:

| Variable                      | Kind                     | Managed by                                       |
| ----------------------------- | ------------------------ | ------------------------------------------------ |
| `PR_LIFECYCLE_CLIENT_ID`      | public, in YAML          | `envctl config push --env production`            |
| `PR_LIFECYCLE_PRIVATE_KEY`    | Vercel sensitive         | `envctl secrets init github-app` (manual rotate) |
| `PR_LIFECYCLE_WEBHOOK_SECRET` | Vercel sensitive, minted | `envctl secrets init` / `rotate github-app`      |

`envctl secrets init github-app --private-key-file <pem>` pushes the private key
and a generated webhook secret, redeploys production, then points the
`rmartz-pr-lifecycle` App's webhook at
`https://pr-lifecycle-app.vercel.app/api/webhook` with that secret.
`envctl secrets rotate github-app --private-key-file <pem>` rotates the webhook
secret the same way, updating GitHub only after the redeploy is `READY`. The
private key can only be generated on the App's settings page; rotate prints the
manual steps. The App's permissions and event subscriptions are also set by hand
there. Never commit the PEM (`*.pem` is gitignored).

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
