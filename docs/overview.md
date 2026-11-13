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

**Shelved.** GitHub webhook traffic pushed the Vercel free tier past its Fast
Origin Transfer quota (10 GB). So every tool is `off` in the
[allowlist](server.md#repo-allowlist), and `rmartz/firebase-nextjs-template` and
`rmartz/group-picks` run the `pr-lifecycle`, `pr-policy` and `merge-safety`
actions from their own workflows again. A revival needs a host whose transfer
cost fits the webhook volume.

Before it was shelved, the server ran on **Vercel** as the existing
`rmartz-pr-lifecycle` App. Both repos were cut over to it after a shadow
(dry-run) period whose plans matched the action's. group-picks was the first
repo with arming and auto-update on. How it works:
[The webhook server](server.md), including
[cutting a repo over](server.md#repo-allowlist).

The design is tracked in
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134).
The proof of concept settled the hosting, the App identity, self-triggered events
and per-repo policy. Approval carry-over, which needs git, runs in a Vercel
Sandbox (see [Approval carry-over](server.md#approval-carry-over)). Per-PR
serialization and a missed-delivery sweep are still deferred; see
[its simplifications](server.md#proof-of-concept-simplifications).

The server is growing into the fleet's PR server (epic
[#5](https://github.com/rmartz/pr-lifecycle-app/issues/5)). It runs as two Apps
from two Vercel projects: the **actor** (`rmartz-pr-lifecycle`) and a **gate**
App that posts the `pr-policy` and `merge-safety` checks; see
[Roles](server.md#roles-actor-and-gate). Record each decision on a page
in this bundle when it is made.
