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
- [Development and CI](development.md) — the toolchain, commands, each CI
  workflow and what it gates, repo hygiene, Dependabot, and where deploy
  automation will go.
- [Testing strategy](testing.md) — how the server is tested: pure event mapping,
  injected GitHub and clock edges, security and replay cases, coverage.
- [The OKF documentation format](okf-format.md) — how these pages are structured
  and validated in this repo.
