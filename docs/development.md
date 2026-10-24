---
type: Reference
title: Development and CI
description: The pr-lifecycle-app toolchain and commands, each CI workflow and what it gates, deploying, rolling back and rotating the actor and gate Vercel projects, repo hygiene and the pre-commit hook, and Dependabot.
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

The repo deploys to **two Vercel projects** on the `reed-8753s-projects` team,
one per [role](server.md#roles-actor-and-gate). Both run the same code from the
same repo and differ only in their env vars:

| Project             | ID                                 | `PR_APP_ROLE` | URL                                    | envctl config       |
| ------------------- | ---------------------------------- | ------------- | -------------------------------------- | ------------------- |
| `pr-lifecycle-app`  | `prj_Hk4QmeVi1BYi48RAPpcne95x3Ptv` | `actor`       | `https://pr-lifecycle-app.vercel.app`  | `deployment/actor/` |
| `pr-lifecycle-gate` | `prj_kAQC6gawmmBbN1j1ag02pA2TqIGe` | `gate`        | `https://pr-lifecycle-gate.vercel.app` | `deployment/gate/`  |

Each is deployed by **Vercel's Git integration**, so there is no deploy
workflow here:

- **Production only.** [`vercel.json`](../vercel.json) sets
  `git.deploymentEnabled` to `main` only, so a push to `main` deploys **both**
  projects and branch pushes build no preview. A preview would be useless
  anyway: each App's webhook points at its production URL. Testing a branch
  end to end would need a second dev App aimed at a preview URL.
- **Build.** The build runs `pnpm run build` as a compile check. The static
  output is `public/`, which holds only a deny-all
  [`robots.txt`](../public/robots.txt). Without an explicit output directory,
  Vercel would serve the repo root as static files. Locally, `vercel link`
  writes `.vercel/`, which is gitignored.
- **Function limits.** `api/webhook.ts` gets `maxDuration: 300`, room for the
  30-second settle wait plus fact-gathering. The webhook itself is acknowledged
  first; see [The webhook server](server.md#a-delivery-step-by-step).
- **Secrets.** See [Secrets and env vars](#secrets-and-env-vars-envctl). Never
  commit them or put them in Actions logs; `.gitignore` excludes `.env*` and
  `*.pem`.
- **Rollback.** Roll back **each project on its own**: promote its previous
  production deployment (`vercel rollback --scope reed-8753s-projects` from a
  directory linked to that project, or Instant Rollback in its dashboard), then
  revert on `main`. A revert redeploys both projects. To stop a tool acting on a
  repo immediately, set its mode to `off` in [`src/repos.ts`](../src/repos.ts),
  or clear that App's webhook URL.

## Secrets and env vars (envctl)

Each project's variables are declared for
[envctl](https://github.com/rmartz/envctl)'s `github-app` provider in its own
config directory, all on the **Production** target only.
[`deployment/actor/`](../deployment/actor/manifest.yml) covers the actor and
[`deployment/gate/`](../deployment/gate/manifest.yml) the gate:

| Actor variable                | Gate variable            | Kind                     | Managed by                                  |
| ----------------------------- | ------------------------ | ------------------------ | ------------------------------------------- |
| `PR_APP_ROLE` (`actor`)       | `PR_APP_ROLE` (`gate`)   | public, in YAML          | `envctl config push --env production`       |
| `PR_LIFECYCLE_CLIENT_ID`      | `PR_GATE_CLIENT_ID`      | public, in YAML          | `envctl config push --env production`       |
| `PR_LIFECYCLE_PRIVATE_KEY`    | `PR_GATE_PRIVATE_KEY`    | Vercel sensitive         | `envctl secrets init` / `rotate github-app` |
| `PR_LIFECYCLE_WEBHOOK_SECRET` | `PR_GATE_WEBHOOK_SECRET` | Vercel sensitive, minted | `envctl secrets init` / `rotate github-app` |

**Pick the project with `--deployment-dir`.** Each directory's manifest pins
its Vercel project (`projectId` and `teamId`), so the directory alone decides
where its variables and secrets go. Pass it to every envctl command (envctl
3.7.0 or later); the default `deployment` doesn't exist here:

```bash
envctl config push --env production --deployment-dir deployment/gate
```

Use `deployment/actor` for the actor. envctl refuses to run if a `.vercel` link
or `VERCEL_PROJECT_ID` names a different project than the pin, so one App's
credentials can't land in the other's project.

`envctl secrets init github-app --private-key-file <pem>` (with the same
`--deployment-dir`) pushes the private key and a generated webhook secret, redeploys
production, then points the App's webhook at its project's
`/api/webhook` with that secret. The App's webhook must be **Active** first, or
envctl refuses before pushing anything, and its Client ID must already be in
the YAML and pushed, because envctl signs the App JWT with it.

`envctl secrets rotate github-app --private-key-file <pem>` re-mints the webhook
secret and pushes the PEM as the App's key. It redeploys, proves the key with
`GET /app`, and only then updates GitHub's webhook config. To rotate the private
key, generate a new one on the App's settings page and pass that PEM. When the
run logs the key's `SHA256:` fingerprint, delete the replaced key there. For the
actor, keep any key the `PR_LIFECYCLE_PRIVATE_KEY` Actions secrets in other
repos still use. Each App's permissions and event subscriptions are set by hand
on its settings page. Never commit a PEM (`*.pem` is gitignored).

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
