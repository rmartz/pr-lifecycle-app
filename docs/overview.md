---
type: Reference
title: What pr-lifecycle-app is
description: The hosted GitHub App that receives webhooks and runs the @rmartz/pr-lifecycle reconciler, so a repo adopts pr-lifecycle by installing the App; its relation to the library and the action, and its open design.
tags: [overview, github-app, webhooks, architecture]
---

# What pr-lifecycle-app is

`pr-lifecycle-app` is a **hosted GitHub App** for
[`@rmartz/pr-lifecycle`](https://github.com/rmartz/pr-lifecycle), the
event-driven reconciler that recomputes a pull request's lifecycle state from its
current facts, converges its labels, and arms GitHub-native auto-merge when the PR
reaches `approved`.

Today a repo runs the reconciler through the composite action
[`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action),
which needs a caller workflow, its permissions, and the App's Client ID and
private key stored as both an Actions and a Dependabot secret in every repo. With
this App, GitHub delivers webhooks to a server that runs the reconciler, so a repo
adopts pr-lifecycle **by installing the App**: no caller workflow, no per-repo
secrets, and no Actions minutes.

## How it fits

```text
GitHub webhook ──▶ pr-lifecycle-app ──▶ @rmartz/pr-lifecycle (library)
                   verify signature       gatherFacts → reconcilePullRequest
                   map event → PR         → executePlan, over createHttpClient
                   mint install token
```

- **The library owns every decision.** The server consumes `@rmartz/pr-lifecycle`
  as a library: `reconcilePullRequest`, `gatherFacts`, `executePlan` and
  `createHttpClient` from its `src/index.ts`. Lifecycle state, labels, bot
  eligibility and whether to arm are never re-derived here.
- **The server is a thin edge.** It verifies the webhook signature, maps the event
  to the PR(s) it concerns, mints an installation token for that repo, and
  reconciles. It is a sibling of `pr-lifecycle-action`, which consumes the same
  package through its CLI.
- **The action stays supported** for repos that prefer an in-repo workflow. The
  App is an alternative, not a replacement, and a repo must never run both.

Because an approval authorizes a merge, a bug here (reconciling the wrong PR,
trusting an unsigned payload, using one installation's token for another) is a
merge-authorization bug. The [testing strategy](testing.md) is built around that.

## Status and open design

This repo currently holds only its infrastructure: toolchain, CI, and docs. The
server itself is not written yet.

The design is tracked in
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134). Its
open questions are **not** decided here: the hosting choice and its time limits,
the git runner that clean-rebase approval carry-over needs, per-PR serialization,
missed and duplicate deliveries, self-triggered events, per-repo policy, and
coexistence with the merge-safety and pr-policy workflows. When a question is
decided, record the decision on a page in this bundle and link it from
[the index](index.md).
