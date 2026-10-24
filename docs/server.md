---
type: Reference
title: The webhook server
description: How a delivery flows through the server — signature check, event-to-PR mapping, the repo allowlist, per-repo-scoped installation tokens, background reconciles — plus its subscribed events, App permissions, environment and the proof-of-concept simplifications.
tags: [architecture, webhooks, security, github-app, config]
---

# The webhook server

One route, `POST /api/webhook` ([`api/webhook.ts`](../api/webhook.ts)), receives
every delivery for the `rmartz-pr-lifecycle` App. `GET` on the same path returns
the health report.

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

The token asks for the permissions the action's App token gets, plus the reads
the action got from the workflow token, because here one token does everything:
contents, pull requests, issues, statuses and workflows **write**; checks
**read**. The App must already have each of these. Subscribing to `workflow_run`
also needs **Actions: read** on the App.

Because the App token is a real actor, it serves both the reads and the release
writes (the sign-off status, and arming once a repo turns it on). No
`release: 'unavailable'` fallback applies.

## Repo allowlist

The App is installed on repos that still run `rmartz/pr-lifecycle-action`, and a
repo must never be reconciled by both. So the server acts only on the repos
listed in [`src/repos.ts`](../src/repos.ts), each with its policy and a `dryRun`
flag. Enabling a repo is a reviewed code change, not a runtime setting.

| Repo                              | Policy                | Mode                   |
| --------------------------------- | --------------------- | ---------------------- |
| `rmartz/firebase-nextjs-template` | `uat: on`, arming off | live (`dryRun: false`) |

**Cutting a repo over** follows two steps. First, enable it with
`dryRun: true` (shadow mode) while it still runs the action, and compare the
logged plans with the action's results. Then, in the same window, set
`dryRun: false` here and delete the repo's `pr-lifecycle.yml`. Until the second
step merges, both may reconcile; they compute the same plan, so the overlap is
harmless.

**Label writes now start workflows.** The action wrote labels with
`GITHUB_TOKEN`, which starts no workflow runs. The App writes them with its
installation token, so a lifecycle label it adds fires the repo's `labeled`
workflows (pr-policy, merge-safety, preview deploys). A caller that worked
around the old behavior, such as a pr-policy `workflow_run: [pr-lifecycle]`
trigger, can drop the workaround.

## Environment

| Variable                      | Value                                                 |
| ----------------------------- | ----------------------------------------------------- |
| `PR_LIFECYCLE_CLIENT_ID`      | The App's Client ID                                   |
| `PR_LIFECYCLE_PRIVATE_KEY`    | The App's private key (PEM; `\n`-escaped is accepted) |
| `PR_LIFECYCLE_WEBHOOK_SECRET` | The App's webhook secret                              |
| `PR_LIFECYCLE_APP_SLUG`       | Optional; the App slug, default `rmartz-pr-lifecycle` |

While any of the first three is missing, every delivery gets `500` and nothing
runs. Values are never logged.

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
