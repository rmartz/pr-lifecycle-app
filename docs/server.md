---
type: Reference
title: The webhook server
description: How a delivery flows through the server — the actor and gate roles, signature check, event-to-PR mapping, the per-tool repo allowlist and modes, per-repo-scoped installation tokens, background reconciles — plus its subscribed events, App permissions, environment and the proof-of-concept simplifications.
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

No gate tool is routed yet: the gate acknowledges every verified delivery as
`unsubscribed-event` until the pr-policy and merge-safety routes land.

The rest of this page describes the actor unless it says otherwise.

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
   `reconcilePullRequest` once per PR with the repo's policy. Each result is
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
  contents **read**. Nothing merge-capable. The App must already have each of these. Subscribing to `workflow_run`
  also needs **Actions: read** on the App.

Because the App token is a real actor, it serves both the reads and the release
writes (the sign-off status, and arming once a repo turns it on). No
`release: 'unavailable'` fallback applies.

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

| Repo                              | Tool         | Mode   | Policy                |
| --------------------------------- | ------------ | ------ | --------------------- |
| `rmartz/firebase-nextjs-template` | pr-lifecycle | `live` | `uat: on`, arming off |

### Cutting a tool over on a repo

**A label writer** (pr-lifecycle) takes two steps:

1. Add the tool with `mode: 'shadow'` while the repo still runs the action, and
   compare the logged plans with the action's results.
2. In one window, set `mode: 'live'` here and merge the repo PR deleting the
   action's workflow. Until both land, both may write; they compute the same
   plan, so the overlap is harmless.

**A required-check poster** (pr-policy, merge-safety) can't overlap that way:
two creators posting one context overwrite each other. So it shadows under a
distinct context (`<name> (app)`), and once the verdicts match, the rest
happens in one sitting: switch to the real context name, flip the ruleset's
required check to the gate App's `integration_id`, and delete the workflow.

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

The slugs default to `rmartz-pr-lifecycle` and `rmartz-pr-gate`. While the role
is missing or unknown, or any of the role's first three variables is missing,
every delivery gets `500` and nothing runs. Values are never logged.

## Proof-of-concept simplifications

Decided on
[rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134#issuecomment-6389456491);
each is revisited before a wider rollout:

- **Approval carry-over is off.** No `lineage` option is passed, so no git is
  needed. It fails closed: a verdict on an earlier commit doesn't count after a
  rebase.
- **No per-PR serialization.** Concurrent deliveries for one PR may reconcile in
  parallel. Each run recomputes from current facts and the settle wait re-gathers,
  so they converge.
- **No sweep for missed deliveries.** GitHub's redelivery, plus the next event on
  the PR, converges it.
