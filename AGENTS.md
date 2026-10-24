# Agent guide — pr-lifecycle-app

This repo is the home of `pr-lifecycle-app`: a hosted GitHub App that receives
webhooks and runs the [`@rmartz/pr-lifecycle`](https://github.com/rmartz/pr-lifecycle)
reconciler, so a repo adopts pr-lifecycle by installing the App. What it is and
what is still undecided are in [docs/overview.md](docs/overview.md).

Because the reconciler it drives can **merge**, a server bug (wrong PR, unsigned
payload, another installation's token) is a merge-authorization bug. Test
accordingly (see §Testing).

## Documentation lifecycle — every task

Docs live in [`docs/`](docs/index.md) as an OKF bundle. They are part of the
change, not an afterthought.

**On task start — read.** Before editing code, read [docs/index.md](docs/index.md),
then every page relevant to what you are touching, so your change is consistent
with what is documented and you don't re-derive a decision already recorded.

**On task finish — extend, update, trim.** Before opening the PR:

- **Extend.** New behavior, module, route, event subscription, App permission,
  config key, secret, workflow, or decision gets documented — a new page (with OKF
  frontmatter, linked from its directory's `index.md`) or a section on an existing
  one.
- **Update.** Anything your change contradicts is corrected in the same PR. An
  outdated doc is worse than none.
- **Trim.** Delete what is no longer true or no longer earns its place: resolved
  open questions (replace with the decision), "not yet implemented" notes for
  things now implemented, superseded plans, duplicated prose (link instead).
  Docs describe the current state; history belongs in git and PRs.
- **Correct drift you notice** along the way, or file an issue if out of scope.

Keep this file short — it is capped by repo-hygiene's `file-caps` check and only
earns its keep if agents read it. Put detail in `docs/` and link to it from here.

## Common commands

```bash
pnpm install             # first, in every worktree; no token needed
pnpm run build           # tsc → dist
pnpm run typecheck       # tsc --noEmit over src/ and test/
pnpm run lint            # eslint, type-aware (incl. max-lines caps)
pnpm run format:check    # prettier --check
pnpm run test:coverage   # vitest + enforced coverage thresholds (what CI runs)
pnpm run hygiene         # repo-hygiene checks (the pre-commit hook runs --staged)
```

Before pushing, run `ai-pre-push-verify -C <worktree>` and fix every failure.
Toolchain, CI and deploy details: [docs/development.md](docs/development.md).

## Code standards

Most are enforced by ESLint; the intent:

- **Strict TypeScript.** No `any`, no `@ts-ignore` (use `@ts-expect-error` with a
  reason). Favor type inference; explicit generic args are a smell.
- **Exhaustive handling.** Switch over unions (event names, outcomes) without a
  `default` so `switch-exhaustiveness-check` flags a newly added member.
- **Thin edge over the library.** Lifecycle decisions belong to
  `@rmartz/pr-lifecycle`; never re-derive them here. Keep event mapping pure and
  put GitHub, token, clock and storage I/O behind injected interfaces.
- **Secrets never touch the repo or logs.** The App private key and webhook
  secret come from the host's secret store.
- **Named exports only**; no default exports. No IIFEs. `async/await`, not `.then()`.
- **Value sets:** a structural string union or `as const` array over an `enum`.
- **File caps:** `max-lines` 400 (src) / 600 (tests); split src at ~240. The
  response to a cap is extraction, never terser code.
- **Pin dependencies exactly** (`major.minor.patch`, no caret: this is a deployed
  app) and **SHA-pin** every third-party Action with a `# vX.Y.Z` comment.

## Testing

See [docs/testing.md](docs/testing.md) for the full strategy. The rules:

- `describe`/`it` from Vitest (`test()` is lint-banned); fixtures via `make{Domain}()`.
- **Control inputs and outputs** — assert on explicit, non-default values.
- **One reason to fail per test.**
- **Every security rule gets a direct test, including the negative case**: a bad
  webhook signature is rejected; one installation's token never reaches another's
  repo; the App's own events are skipped.
- **Idempotency/replay** — a duplicate delivery, or events in any order, converge
  to the same labels.
- **Coverage thresholds are a floor, not a target.** Lowering one (or any other
  CI loosening) goes in its own dedicated PR, justified on its own merits.

## Repository conformance

This repo is held to the shared repository checklist and **self-manages** its own
config: fix conformance gaps directly here, in a PR. Bootstrap (`ai-ensure-*`) is
a one-time starter, not an ongoing manager.

## Worktrees and PRs

- **Work in a dedicated worktree** under `.git-worktrees/` (`ai-new-worktree`),
  never on `main` in the root checkout. (The one exception was the genesis commit,
  which had no prior branch to base a worktree on.)
- **PR titles must be Conventional Commits** (`feat:`, `fix:`, `docs:`, `ci:`, …).
  The repo squash-merges using the PR title; branch commits stay plain.
- There is no package release. Deploys will run from `main` once the hosting
  choice is made (see [docs/development.md](docs/development.md#deploy)).

## Agent directive files

- **`AGENTS.md` is the single source of truth** for a directory's agent
  instructions — author directives here, never in `CLAUDE.md`.
- **Every `AGENTS.md` has a companion `CLAUDE.md`** in the same directory whose only
  content is `@AGENTS.md`. Enforced by the `md-pairing` check.
