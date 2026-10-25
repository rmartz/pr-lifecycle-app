---
type: Reference
title: The webhook server
description: How a delivery flows through the server — the actor and gate roles, the gate's pr-policy and merge-safety routes, signature check, event-to-PR mapping, the per-tool repo allowlist and modes, per-repo-scoped installation tokens, background reconciles — plus its subscribed events, App permissions, environment and the proof-of-concept simplifications.
tags: [architecture, webhooks, security, github-app, config]
---

# The webhook server

One route, `POST /api/webhook` ([`api/webhook.ts`](../api/webhook.ts)), receives
every delivery. `GET` on the same path returns the health report.

## Roles: actor and gate

The repo deploys to two Vercel projects that run the same code. `PR_APP_ROLE`
selects which App a deployment serves, and so which handler `/api/webhook`
runs ([`src/http.ts`](../src/http.ts)):

| Role    | Vercel project      | App                   | Handler                                       | What it does                                                    |
| ------- | ------------------- | --------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `actor` | `pr-lifecycle-app`  | `rmartz-pr-lifecycle` | [`handleWebhook`](../src/handler.ts)          | Reconciles lifecycle labels and the sign-off status; can merge. |
| `gate`  | `pr-lifecycle-gate` | the gate App          | [`handleGateWebhook`](../src/gate-handler.ts) | Posts the `pr-policy` and `merge-safety` checks; cannot merge.  |

The split keeps one leaked key from both posting a green gate **and** merging
(decided on
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134)).
So each role reads only its own App's variables
([`src/server-config.ts`](../src/server-config.ts)), and each project holds
only its own App's key. A gate deployment never wires or runs the actor
handler, and the actor never runs the gate's. Both verify the signature first
with their own App's webhook secret, so a delivery signed for one App is
rejected (`401`) by the other.

The gate runs [pr-policy](#the-gate-pr-policy) and
[merge-safety](#the-gate-merge-safety). Each tool decides on its own whether a
delivery concerns it. The gate responds `202` when either accepts, and its body
says what each made of it (`{ prPolicy, mergeSafety }`).
The rest of this page describes the actor unless it says otherwise.

## The gate: pr-policy

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
[Cutting a tool over](#cutting-a-tool-over-on-a-repo).

**Gate App permissions and events.** Checks, commit statuses, pull requests
and issues write; contents read; metadata read. It subscribes to `pull_request`
and `status`, and to `push`, `check_run`, `check_suite` and `workflow_run` (the
last needs Actions read) for merge-safety.

## The gate: merge-safety

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

The gate's own `labeled`/`unlabeled`/`edited` events are skipped.

**Only a push-started run is the base's CI.** A workflow started by any other
event also reports the default branch as its head branch. That includes the
`status`-triggered `pr-policy.yml`, which runs on every commit status. Following
those runs loops: each invalidation posts pending statuses, which start
`status` workflows, whose completions would invalidate again. On the template
that multiplied the deliveries until the gate's installation ran out of rate
limit. A base CI run also fans out only while its commit is still the branch
tip, so a stale or redelivered run costs one read.

**Evaluate.** Read the PR, re-reading while GitHub computes `mergeable`, and
skip it unless it is open. Gather the facts and take the library's verdict, or
its fail-safe `Could not evaluate`. Post the check-run, completing any open run
of the name in place, mirrored to a commit status. Live, also reconcile
`update required` / `merge conflict`.

**Invalidate** replaces the workflow's per-PR `workflow_dispatch` fan-out:

1. List the open PRs on the moved branch. If the installation is already below
   the rate-limit floor, stop here and mark nothing.
2. Mark every one pending (`Re-evaluating`) first, which holds its merge.
3. Re-evaluate them in place, at most `concurrency` at a time (the repo's
   `mergeSafety` policy, 4 on the template).

A base push with about 20 open PRs is then a few rounds of a few seconds each,
well inside the function's 300 s. Each response's `x-ratelimit-remaining` is
recorded ([`src/rate-limit.ts`](../src/rate-limit.ts)) and logged. Below
`RATE_LIMIT_FLOOR` (500) the fan-out stops: the PRs it didn't reach keep their
pending mark, so they stay held until the next base event or a Re-run.

A failed read is logged with the last failed response's status and API path
(`failure`, never a token or query), so a rate limit (403/429) can be told apart
from a missing permission or installation (403/404).

**Shadow vs live.** Shadow posts `merge-safety (app)` and writes no labels;
live posts `merge-safety` and reconciles them. The cutover is the same as
pr-policy's ([Cutting a tool over](#cutting-a-tool-over-on-a-repo)).

## A delivery, step by step

1. **Signature** ([`src/signature.ts`](../src/signature.ts)). The raw body's
   HMAC-SHA256 under the webhook secret must match `X-Hub-Signature-256`, compared
   in constant time. Anything else gets `401`, and nothing reads the body first.
2. **Decision** ([`src/events.ts`](../src/events.ts)). A pure function of the
   event name and payload, ported from the action's `resolve_prs` so both
   reconcile the same PRs. It ignores (with a `200` and the reason) a delivery
   that is:
   - an event the App doesn't subscribe to, or an action that can't change a
     PR's lifecycle state;
   - from a repository that isn't enabled (see [Repo allowlist](#repo-allowlist));
   - a `labeled`, `unlabeled`, `review_requested` or `review_request_removed`
     event whose sender is the App's own bot, so its writes don't re-trigger it;
   - malformed (no installation, repository or PR).
3. **Accept** ([`src/handler.ts`](../src/handler.ts)). Responds `202` at once.
   GitHub allows 10 seconds per delivery, and a reconcile with its settle wait
   can take longer, so the reconcile runs after the response under Vercel's
   `waitUntil`.
4. **Reconcile** ([`src/run-target.ts`](../src/run-target.ts)). Mints an
   installation token, resolves the PRs, and calls the library's
   `reconcilePullRequest` once per PR with the repo's policy and a sandboxed git
   for [approval carry-over](#approval-carry-over). Each result is
   logged in the CLI's `--json` shape, so shadow-mode plans can be compared with
   the action's `results` output. Failures are logged and never thrown; the next
   event converges the PR.

## Subscribed events

| Event                 | Actions                                                                                                                                   | PRs reconciled                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pull_request`        | opened, reopened, ready_for_review, converted_to_draft, synchronize, edited, labeled, unlabeled, review_requested, review_request_removed | the PR                                                                |
| `pull_request_review` | submitted, dismissed, edited                                                                                                              | the PR                                                                |
| `check_suite`         | completed                                                                                                                                 | listed PRs into this repo, else the open PRs for the suite's head SHA |
| `workflow_run`        | completed                                                                                                                                 | listed PRs into this repo, else the open PRs for the run's head SHA   |

`workflow_run` stands in for `check_suite`, which never fires for suites GitHub
Actions creates. Unlike the action, the server doesn't filter by workflow name:
any completed run re-reconciles its PRs, which is idempotent.

## Tokens and permissions

Each reconcile mints its own installation token
([`src/installation-token.ts`](../src/installation-token.ts)) for the
installation named in the payload, **scoped to that one repository**
(`repositories: [name]`). A token minted for one event can't act on any other
repository, even in the same installation. The App JWT is signed with the App's
Client ID as issuer.

Every token is minted with one tool's explicit `permissions`
([`src/installation-token.ts`](../src/installation-token.ts)), so a code path
never holds more than its tool needs.

- **pr-lifecycle** (`PR_LIFECYCLE_PERMISSIONS`) asks for what the action's App
  token gets, plus the reads the action got from the workflow token, because
  here one token does everything: contents, pull requests, issues, statuses and
  workflows **write**; checks **read**.
- **Gate tools** (`GATE_PERMISSIONS`) get at most checks and statuses
  **write**, pull requests and issues **write** (the labels they own), and
  contents **read**. Nothing merge-capable.

Each App must already have every permission its tokens ask for. Subscribing to
`workflow_run` also needs **Actions: read** on the App.

Because the App token is a real actor, it serves both the reads and the release
writes (the sign-off status, and arming once a repo turns it on). No
`release: 'unavailable'` fallback applies.

## Approval carry-over

A review on an earlier commit still counts after a clean rebase or base merge,
as with the action. The library verifies that with `git merge-tree`, which has
no REST equivalent, so the server runs git in a
[Vercel Sandbox](https://vercel.com/docs/sandbox) microVM
([`src/sandbox-git.ts`](../src/sandbox-git.ts),
[`src/vercel-sandbox.ts`](../src/vercel-sandbox.ts)). The library's `GitRunner`
issues one sandbox command per git call; the reconcile stays synchronous.

- **Lazy, one per run.** The VM boots on the first git call, so a PR with no
  review on an earlier commit never creates one. A run's PRs share it, and it is
  stopped when the run ends. It has 1 vCPU, the `vercel/sandbox/universal` image
  (git 2.53; the minimal `ubuntu` image has none), no persistence, and a 300 s
  lifetime bounding a VM orphaned by a killed function.
- **The token never enters the VM.** The library would pass the fetch token as
  git config; the runner drops that env. The sandbox's firewall injects the
  installation token instead, and only on git's fetch endpoints
  (`info/refs?service=git-upload-pack`, `git-upload-pack`) on `github.com`.
  Every other `github.com` request, a push included, gets a `403` from the
  firewall, so the token's write scope is unreachable. Every other domain is
  denied.
- **Fails closed.** A boot failure, a quota or concurrency limit, a command
  error, or a command (boot included) over 60 s rejects the git call, and every
  later call in the run rejects without retrying. The library records that as
  `carryOver.stoppedBecause: "verification failed: …"` in the logged result, and
  the earlier approval doesn't count. It is never counted unverified.
- **Auth.** On Vercel the SDK uses the deployment's OIDC token; no secret is
  configured. Only the actor role reconciles, so only the actor's project
  (`pr-lifecycle-app`) creates sandboxes, and its OIDC token must stay enabled.

Measured on `rmartz/firebase-nextjs-template` (rmartz/pr-lifecycle-app#8): about
3 s per check end to end (boot 0.25–0.5 s, about 0.2 s per git command, a
depth-1 fetch about 0.5 s, stop about 1.2 s). The library's worst case (20 merge
steps and 3 rebase checks) is about 25 s, well within the 300 s function.

**Limits.** The team is on Vercel Hobby: 5,000 sandbox creations, 5 active-CPU
hours and 420 GB-hours of memory a month, and 10 concurrent sandboxes. Past a
quota, creation pauses until the cycle resets and carry-over fails closed;
nothing is billed. On Pro, a run costs about $0.0007.

**Fallback.** If Sandbox capacity or cost stops fitting, the App dispatches a
small central workflow that runs the git check on an Actions runner, as decided
on [rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134).
That makes carry-over asynchronous: the verdict counts only from the reconcile
after the workflow reports back.

## Repo allowlist

The App is installed on repos that still run the tools' actions, and a repo
must never be handled by both the App and the action for one tool. So each tool
acts only on the repos listed in [`src/repos.ts`](../src/repos.ts). Enabling a
repo is a reviewed code change, never a runtime setting or a file read from a
PR head (a PR could otherwise switch off the gate it is waiting on).

Each repo maps each tool to a `mode` and that tool's policy:

```ts
'owner/name': {
  prLifecycle: { mode: 'live', policy: { uat: 'on', armAutoMerge: false } },
},
```

| Mode     | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| `off`    | The tool ignores the repo, exactly as if it were unlisted.           |
| `shadow` | Plan and log without writing. The repo still runs the tool's action. |
| `live`   | Plan and write. The repo no longer runs the action.                  |

A tool left out of a repo's entry is `off`. Only `shadow` and `live` reach a
run: the lookup returns nothing for `off`, so a delivery for that repo is
acknowledged as `repo-not-enabled`. Each tool cuts over per repo on its own.

| Repo                              | Tool         | Mode     | Policy                                                |
| --------------------------------- | ------------ | -------- | ----------------------------------------------------- |
| `rmartz/firebase-nextjs-template` | pr-lifecycle | `live`   | `uat: on`, arming off                                 |
| `rmartz/firebase-nextjs-template` | pr-policy    | `shadow` | UAT gate on, `requireUatLabel`, `retitleDependabotCi` |
| `rmartz/firebase-nextjs-template` | merge-safety | `shadow` | `concurrency: 4`                                      |

### Cutting a tool over on a repo

**A label writer** (pr-lifecycle) takes two steps:

1. Add the tool with `mode: 'shadow'` while the repo still runs the action, and
   compare the logged plans with the action's results.
2. In one window, set `mode: 'live'` here and merge the repo PR deleting the
   action's workflow. Until both land, both may write; they compute the same
   plan, so the overlap is harmless.

**A required-check poster** (pr-policy, merge-safety) can't overlap that way:
two creators posting one context overwrite each other. So it takes these steps:

1. **Shadow.** Add the tool with `mode: 'shadow'`. The gate posts under
   `<name> (app)`, never the real name. Compare its verdicts with the action's
   on real PRs until they match.
2. **Cut over, in one sitting:**
   1. Merge the PR here that sets `mode: 'live'`. Once it deploys, the gate
      posts the real `<name>`.
   2. Flip the repo ruleset's required `<name>` check from GitHub Actions
      (`integration_id` 15368) to the gate App's ID. Only the gate's key can
      satisfy it from then on, which closes the gap where any workflow with
      `statuses: write` could post a green check. A person approves this
      settings change.
   3. Merge the repo PR deleting the action's workflow. It needs
      `CI change approved`.

   Between steps 2.1 and 2.3, both post `<name>` with the same verdict, so
   keep that window short.

Never leave a tool `live` on a repo that still runs its action.

**Label writes now start workflows.** The action wrote labels with
`GITHUB_TOKEN`, which starts no workflow runs. The App writes them with its
installation token, so a lifecycle label it adds fires the repo's `labeled`
workflows (pr-policy, merge-safety, preview deploys). A caller that worked
around the old behavior, such as a pr-policy `workflow_run: [pr-lifecycle]`
trigger, can drop the workaround.

## Environment

| Variable      | Value                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| `PR_APP_ROLE` | `actor` or `gate`; selects the route and which App's variables are read |

Each role then reads its own App's variables, and never the other's:

| Actor (`rmartz-pr-lifecycle`) | Gate                     | Value                                                 |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| `PR_LIFECYCLE_CLIENT_ID`      | `PR_GATE_CLIENT_ID`      | The App's Client ID                                   |
| `PR_LIFECYCLE_PRIVATE_KEY`    | `PR_GATE_PRIVATE_KEY`    | The App's private key (PEM; `\n`-escaped is accepted) |
| `PR_LIFECYCLE_WEBHOOK_SECRET` | `PR_GATE_WEBHOOK_SECRET` | The App's webhook secret                              |
| `PR_LIFECYCLE_APP_SLUG`       | `PR_GATE_APP_SLUG`       | Optional; the App slug (bot login `<slug>[bot]`)      |

The slugs default to `rmartz-pr-lifecycle` and `rmartz-pr-gate`. The registered
gate App is `rmartz-pr-lifecycle-gate`, so the gate project sets
`PR_GATE_APP_SLUG` ([`deployment/gate/production.yml`](../deployment/gate/production.yml)).
While the role
is missing or unknown, or any of the role's first three variables is missing,
every delivery gets `500` and nothing runs. Values are never logged.

## Proof-of-concept simplifications

Decided on
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134#issuecomment-6389456491);
each is revisited before a wider rollout:

- **No per-PR serialization.** Concurrent deliveries for one PR may reconcile in
  parallel. Each run recomputes from current facts and the settle wait re-gathers,
  so they converge.
- **No sweep for missed deliveries.** GitHub's redelivery, plus the next event on
  the PR, converges it.
