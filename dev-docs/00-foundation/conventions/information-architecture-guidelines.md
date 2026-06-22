# Information architecture guidelines (for LLM and humans)

Purpose of this document: keep the project dev-docs IA consistent, link-clean, and traceable after the migration to the numbered dev-docs tree.

'Dev-docs' documents in-flight development work. The target user is a fellow developer working on the project, or a hand-off to another team. It answers: what is being built and what has been built. For user-facing documentation or future audiences, readers should be advised to see the `docs/` or `user-docs` folders.

## Ground rules

- Use the numbered lifecycle folders only:
  - `00-foundation`
  - `01-product`
  - `02-research`
  - `03-design`
  - `04-architecture`
  - `05-planning`
  - `06-delivery`
  - `07-quality`
  - `08-operations`
  - `09-user-docs`
  - `99-archive`
- Every top-level folder must contain an `index.md` describing purpose, subfolders, owners, and update cadence.
- Standardize on markdown links. Do not use wikilinks.
- When adding new content, update the nearest index.
- Archive, do not delete: move superseded dev-docs into `99-archive/` with a one-line reason and successor link.

## Commands

- Check links: `npm run lint:links`
- Check IA shape: `npm run lint:ia`
- Fix wikilinks to markdown: `npm run lint:links:fix`

## How to add dev-docs

1. Pick the correct lifecycle folder and create or reuse a subfolder.
2. Add or update `index.md` to mention the new file and its owner.
3. Link back to the source of truth and forward to tests or runbooks when useful.
4. Run `npm run lint:links` and `npm run lint:ia` before opening a PR.

## Migration notes

- 2026-06-22: initialized the dev-docs IA while moving devbox access behind Caddy. See [migration notes](../../06-delivery/migrations/dev-docs-update-2026-06-22/notes.md).

## Ownership

- Project contributors maintain this file and `dev-docs/README.md`.
- Reviewers enforce IA checks in PRs.
