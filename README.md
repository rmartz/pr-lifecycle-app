# pr-lifecycle-app

A **hosted GitHub App** for
[`@rmartz/pr-lifecycle`](https://github.com/rmartz/pr-lifecycle), the
event-driven pull-request lifecycle reconciler. GitHub delivers webhooks to this
server, which runs the reconciler: it recomputes each PR's lifecycle state from
its current facts, converges its labels, and arms GitHub-native auto-merge when
the PR reaches `approved`.

Adopting pr-lifecycle through the App means **installing it**: no caller
workflow, no per-repo secrets, and no Actions minutes. Repos that prefer an
in-repo workflow keep using
[`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action); a
repo runs one or the other, never both.

> **Status:** repository infrastructure only. The server is not written yet, and
> its design is open in
> [rmartz/pr-lifecycle#134](https://github.com/rmartz/pr-lifecycle/issues/134).

## Documentation

See [docs/index.md](docs/index.md), starting with
[docs/overview.md](docs/overview.md). Contributors (human or agent) should start
with [AGENTS.md](AGENTS.md).

## Requirements

- Node.js >= 24
- pnpm 10 (pinned via `packageManager`)

## Local development

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run hygiene
```

## License

[MIT](LICENSE)
