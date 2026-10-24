---
type: Reference
title: Testing strategy
description: How pr-lifecycle-app is tested — pure event-to-PR mapping, injected GitHub, token and clock edges, signature and installation-scoping security cases, replay and duplicate-delivery idempotency, and enforced coverage thresholds.
tags: [testing, vitest, coverage, conventions]
---

# Testing strategy

The server decides which PR a webhook reconciles and with which installation's
token, and the reconciler it calls can merge. A missed branch is a potential
wrong merge, so the suite is designed around that.

## Shape of the code under test

- **A pure core.** Mapping a webhook event to the PR(s) it concerns, and deciding
  whether to act on it at all, are pure functions of the payload. They take no
  clients and do no I/O, so they are tested exhaustively with plain values.
- **Thin, injected edges.** The GitHub client, installation-token minting, the
  clock, and any lock or queue are interfaces passed in by the caller. Edge tests
  use hand-written fakes of those interfaces, never a mocked `fetch` or network.
- **The reconciler is not re-tested here.** `@rmartz/pr-lifecycle` owns lifecycle
  state, labels and auto-merge, and tests them itself. Tests here cover what the
  server adds: which PR, which token, whether to run.
- **A thin process shim.** The HTTP entry point only wires the host's request and
  response to a tested handler, and may be excluded from coverage for that reason.

## What every change must test

- **Signature verification, including the negative case.** A payload with a
  missing, malformed, or wrong `X-Hub-Signature-256` is rejected before anything
  else runs, and a valid one is accepted.
- **Installation scoping.** A token minted for one installation is never used for
  a repository in another.
- **Self-triggered events.** An event the App's own writes caused is skipped, and
  the same event from a person still reconciles.
- **Replay and idempotency.** A duplicate delivery, or the same events in any
  order, converges to the same labels and makes no second write.
- **Each subscribed event, directly.** One case per event type the App subscribes
  to, built from a payload that exercises exactly that mapping.

## Conventions

- `describe`/`it` from Vitest; `test()` is lint-banned.
- Fixture builders are named `make{Domain}()` (e.g. `makePullRequestEvent()`) and
  take overrides, so each test states only the fields it depends on.
- Assert on explicit, non-default values; one reason to fail per test.
- Test files live under `test/` and mirror `src/` paths
  (`src/health.ts` → `test/health.test.ts`).

## Coverage

`pnpm run test:coverage` (what CI's **Test** job runs) enforces the thresholds in
[`vitest.config.ts`](../vitest.config.ts). They are a floor, not a target: a
passing threshold does not mean a case is tested. Lowering a threshold is a CI
loosening and must land in its own dedicated PR with its own justification.
