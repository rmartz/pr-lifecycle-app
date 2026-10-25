---
okf_version: '0.2'
---

# Documentation

Documentation for `pr-lifecycle-app`, written in
[Open Knowledge Format](okf-format.md). Agents: read this index and the pages
relevant to your task before editing code — see
[AGENTS.md](../AGENTS.md#documentation-lifecycle--every-task).

- [What pr-lifecycle-app is](overview.md) — the hosted GitHub App that runs the
  pr-lifecycle reconciler from webhooks, how it relates to the library and the
  action, and where its design is still open.
- [The webhook server](server.md) — the actor and gate roles, the
  required-check cutover, and how a
  delivery is verified, mapped to PRs, scoped to one repository's token and
  reconciled; subscribed events, per-tool token permissions, the per-tool repo
  allowlist and its off/shadow/live modes, environment, and the
  proof-of-concept limits.
- [The gate role](gate.md) — the gate's pr-policy and merge-safety routes,
  their events and shadow modes, merge-safety's deduplicated fan-out, and the
  gate's API budget with its pinned per-delivery costs.
- [Development and CI](development.md) — the toolchain, commands, each CI
  workflow and what it gates, deploying, rolling back and rotating the two
  Vercel projects with envctl, repo hygiene, and Dependabot.
- [Testing strategy](testing.md) — how the server is tested: pure event mapping,
  injected GitHub and clock edges, security and replay cases, coverage.
- [The OKF documentation format](okf-format.md) — how these pages are structured
  and validated in this repo.
