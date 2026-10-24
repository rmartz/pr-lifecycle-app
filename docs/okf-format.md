---
type: Reference
title: The OKF documentation format
description: How docs/ pages here are structured with Open Knowledge Format frontmatter, the fields this repo validates, and the authoritative spec to defer to.
tags: [docs, okf, conventions]
---

# The OKF documentation format

Everything under `docs/` follows Google's **Open Knowledge Format (OKF)**: a
convention for knowledge pages that are equally legible to humans and to agents.
Each page is a markdown file whose body is prose and whose leading YAML
frontmatter carries structured metadata, with pages linked to one another by
ordinary markdown links. The frontmatter lets an agent filter and rank pages by
`type` / `tags` and traverse the link graph without a translation layer.

> **Authoritative reference.** This page describes how we _apply_ OKF here. For
> any question about the format itself, defer to the upstream specification:
>
> **<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>**
>
> We target **OKF v0.2**. Where this page and the spec disagree, the spec wins;
> open a PR to correct this page.

## Content pages

Every page that documents a piece of this repo carries frontmatter delimited by
`---` fences at the very top of the file:

```yaml
---
type: Library # required
title: Webhook signature verification # required here
description: One specific sentence — the search surface an agent matches on. # required here
resource: src/verify.ts # required for every non-Design, non-Reference type; must exist
tags: [webhooks, security] # optional
---
```

This repo runs the **code-documentation flavour** of the `okf` check, which is
stricter than the open spec in two ways:

- **`type`** is constrained to a curated vocabulary: **`Skill`**, **`Script`**,
  **`Library`**, **`Design`**, plus **`Reference`** for concept / guide pages.
- **`resource`** (a repo-relative path that must **exist on disk**) is required
  on every non-`Design`, non-`Reference` page, binding each doc to the code it
  describes. When a module gains a `Library` page, point `resource` at it.

The vocabulary and resource-exempt types are configured in
[`.repo-hygiene.yml`](../.repo-hygiene.yml) under `checks.okf`.

## Index pages

Each directory in the bundle carries an **`index.md`** that links its content
pages and its sub-directory indexes. Index files carry **no frontmatter**, except
that the bundle-root [`docs/index.md`](index.md) may carry a single
`okf_version` key. Every content page must be reachable by following links from
`docs/index.md` down. Both conventions are enforced by the `okf-index` check.

## Enforcement

The **Repo Hygiene** workflow runs `okf`, `okf-index`, and `docs-links` (link and
`#anchor` integrity), and the pre-commit hook runs them over staged content. Run
them locally with:

```bash
pnpm run hygiene
```
