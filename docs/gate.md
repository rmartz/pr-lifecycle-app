---
type: Reference
title: The gate role
description: The gate App's two routes, pr-policy and merge-safety, with their events, shadow and live modes, merge-safety's deduplicated fan-out, and the gate's per-installation API budget, its pinned per-delivery costs and its out-of-budget behavior.
tags: [gate, pr-policy, merge-safety, webhooks, rate-limit]
---

# The gate role

The gate deployment ([roles](server.md#roles-actor-and-gate)) runs two tools,
each deciding on its own whether a delivery concerns it. It responds `202` when
either accepts, and its body says what each made of it (`{ prPolicy,
mergeSafety }`).

## pr-policy

The gate runs [`@rmartz/pr-policy`](https://github.com/rmartz/pr-policy) the way
the repo's `pr-policy.yml` ran `rmartz/pr-policy-action`, so a repo needs no
workflow for it ([`src/gate-handler.ts`](../src/gate-handler.ts),
[`src/run-pr-policy.ts`](../src/run-pr-policy.ts)).

**Events** ([`src/gate-events.ts`](../src/gate-events.ts), pure):

| Event          | Actions or context                                        | PRs evaluated                                                                 |
| -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pull_request` | opened, synchronize, reopened, edited, labeled, unlabeled | the PR                                                                        |
| `status`       | context `pr-lifecycle/sign-off` only                      | the open PRs whose head is the SHA                                            |
| `check_run`    | `rerequested` on `pr-policy` or `pr-policy (app)`         | its PRs: the native **Re-run** button, which replaces re-running the workflow |

A `labeled`, `unlabeled` or `edited` event the gate's own bot sent is skipped,
so its label and retitle writes don't re-trigger it. The actor App's label
writes do re-evaluate, which is why no `workflow_run` re-trigger is needed. Any
other status, the gate's own included, is ignored.

**One evaluation** uses a token minted with `GATE_PERMISSIONS` for the event's
repository, and pr-policy's fetch client:

1. Gather the PR's facts through the library.
2. If the repo opts in, compute the Dependabot `ci` retitle. Live, apply it with
   the gate token; shadow, only judge the retitled title.
3. Evaluate with `selectChecks(policy)`.
4. Live, apply the label edits pr-policy plans (`CI approval needed`).
5. Post the verdict (check-run and commit status) and one status per check.
6. Log the outcome, title and each check's state.

**Settings come from server config only.** `skipUat`, `requireUatLabel`,
`retitleDependabotCi` and `signOffStatusCreators` are the repo's `prPolicy`
policy in [`src/repos.ts`](../src/repos.ts), never anything the PR can edit.
The action got the same guarantee from `pull_request_target` reading its
inputs from the default branch.

**Shadow vs live.** In `shadow` the gate posts the verdict as
`pr-policy (app)` and the statuses as `pr-policy (app) / <check>`, and changes
nothing on the PR. The action keeps posting the real `pr-policy` beside it, and
the two can be compared on each PR and in the gate's logs. In `live` the gate
posts `pr-policy` and makes the writes. For the required-check cutover, see
[Cutting a tool over](server.md#cutting-a-tool-over-on-a-repo).

**Gate App permissions and events.** Checks, commit statuses, pull requests
and issues write; contents read; metadata read. It subscribes to `pull_request`
and `status`, and to `push`, `check_run`, `check_suite` and `workflow_run` (the
last needs Actions read) for merge-safety.

## merge-safety

The gate runs [`@rmartz/merge-safety`](https://github.com/rmartz/merge-safety)
in-process, so a repo needs no `merge-safety.yml`
([`src/run-merge-safety.ts`](../src/run-merge-safety.ts),
[`src/merge-safety-evaluate.ts`](../src/merge-safety-evaluate.ts)). The library's
**API-backed fact source** (`makeApiGitRunner`) answers its git queries from
the REST compare and commit APIs, so no checkout is needed. It fails closed past
the compare API's caps and reports `Could not evaluate`. The glue the CLI does
with `gh` lives in [`src/merge-safety-io.ts`](../src/merge-safety-io.ts): read
the PR, probe the base's checks and required contexts, post the check, list
open PRs.

**Events** ([`src/merge-safety-events.ts`](../src/merge-safety-events.ts), pure):

| Event          | When                                                      | Does                                                    |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `pull_request` | opened, synchronize, reopened, edited, labeled, unlabeled | evaluates the PR                                        |
| `push`         | to a branch (not a tag, not a deletion)                   | invalidates the open PRs based on that branch           |
| `workflow_run` | completed, on the default branch, started by a `push`     | invalidates the default branch's open PRs (base health) |
| `check_run`    | `rerequested` on `merge-safety` or `merge-safety (app)`   | re-evaluates its PRs: the native **Re-run** button      |

The gate's own `labeled`/`unlabeled`/`edited` events are skipped. So is any
label change other than `hotfix`, the one label the verdict reads, and any edit
that doesn't change the title. The actor writes several lifecycle labels per PR
change, and each would otherwise re-evaluate.

**Only a push-started run is the base's CI.** A workflow started by any other
event also reports the default branch as its head branch. That includes the
`status`-triggered `pr-policy.yml`, which runs on every commit status. Following
those runs loops: each invalidation posts pending statuses, which start
`status` workflows, whose completions would invalidate again. On the template
that multiplied the deliveries until the gate's installation ran out of rate
limit.

**Evaluate.** Read the PR, re-reading while GitHub computes `mergeable`, and
skip it unless it is open. Gather the facts and take the library's verdict, or
its fail-safe `Could not evaluate`. Post the check-run, completing any open run
of the name in place, mirrored to a commit status. Live, also reconcile
`update required` / `merge conflict`. The check-run's `external_id` records the
**base key** the verdict was computed against
([`src/merge-safety-dedupe.ts`](../src/merge-safety-dedupe.ts)): the base tip
plus a digest of its required checks' conclusions, everything the verdict reads
from the base.

**Invalidate** replaces the workflow's per-PR `workflow_dispatch` fan-out. A push
to `main` reaches the gate as one `push` and one `workflow_run` per push-started
workflow (four on the template), so the fan-out is built to be cheap to repeat:

1. Read the base tip. A base CI run whose commit is no longer the tip stops
   here, after one read.
2. Compute the base key, and list the open PRs on the branch.
3. Keep only the PRs whose latest gate check-run isn't a completed verdict for
   this key. A repeat for an unchanged base re-evaluates nothing.
4. Mark those pending (`Re-evaluating`), which holds their merge, and
   re-evaluate them in place, at most `concurrency` at a time (the repo's
   `mergeSafety` policy, 4 on the template).

Each run reads through a per-delivery cache
([`src/memo-client.ts`](../src/memo-client.ts)), so what every PR shares (the
base tip, each base commit, the base's check-runs and required checks) is read
once per fan-out. It never caches a PR or a check-run listing by name, which the
run waits on or changes itself.

**Shadow vs live.** Shadow posts `merge-safety (app)` and writes no labels;
live posts `merge-safety` and reconciles them. The cutover is the same as
pr-policy's ([Cutting a tool over](server.md#cutting-a-tool-over-on-a-repo)).

## API budget

The gate has one hourly REST budget per installation, shared by every repo and
both tools. Measured per delivery (`test/api-budget.test.ts` pins these):

| Delivery                                              | Calls |
| ----------------------------------------------------- | ----- |
| merge-safety, one PR evaluation (base current)        | 9     |
| merge-safety fan-out, 5 PRs with stale verdicts       | 54    |
| merge-safety fan-out, 5 PRs with current verdicts     | 9     |
| merge-safety, a stale base CI run                     | 1     |
| a `status`-started workflow run; a non-`hotfix` label | 0     |

Before these limits, every completed workflow on `main` (including the
`status`-started ones) fanned out to every open PR at 62 calls for 5 PRs, and a
repeat cost the same again.

**pr-policy re-evaluations that change nothing write nothing.** A pr-policy
evaluation measured 25–33 calls live, and about ten of those are writes: the
verdict's check-run and status, plus one status per check. Most re-evaluations
repeat the last verdict, because the actor re-posts an unchanged
`pr-lifecycle/sign-off` status on every reconcile, several per PR change. So
the gate reads the head's combined status first (one call,
[`src/pr-policy-statuses.ts`](../src/pr-policy-statuses.ts)) and skips every
write when the verdict and each per-check status are already the latest of their
context. Its `evaluated` log says whether it `posted`.

**Out of budget, the gate posts nothing.** Below `RATE_LIMIT_FLOOR` (500
remaining), or after a rate-limit response (429, or 403 with nothing left), it
skips the evaluation or fan-out and logs the skip
([`src/rate-limit.ts`](../src/rate-limit.ts)). It never posts a verdict built on
rate-limited reads: a `Could not evaluate` from a starved gate would be a red
required check once live. The PRs a stopped fan-out didn't reach keep their
pending mark.

Every accepted delivery ends with a `delivery done` log carrying its `apiCalls`
and `rateLimitRemaining`. A failed read logs the last failed response's status
and API path (`failure`, never a token or query), so a rate limit can be told
apart from a missing permission or installation (403/404).
