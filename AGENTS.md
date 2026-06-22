# AGENTS.md

Brief map for Desktop Linear.

## Purpose

- Codex-native local issue tracker for Desktop Symphony projects.
- State is owned by the app on disk.
- Primary DB: `/path/to/dev/desktop-linear/data/desktop-linear.sqlite`.
- Append-only event mirror: `/path/to/dev/desktop-linear/data/desktop-linear-events.jsonl`.

## Run

- `npm start`
- Open `http://127.0.0.1:4888` in the Codex in-app browser.

## Validation

- `npm run validate`

## Rules

- Keep the app dependency-free unless a dependency is explicitly approved.
- Use Desktop Symphony states: `todo`, `in_progress`, `rework`, `code_review`, `human_review`, `merging`, `done`, `canceled`.
- Keep Desktop Symphony protocol details in docs and source comments short.

## Project documentation structure

For readers: This project follows a strict information architecture structure for its documentation, using the numbered lifecycle folders listed below. Each contains an index with links to its contents.

For contributors: When adding, updating, or moving documentation, follow the strict IA conventions documented in dev-docs/00-foundation/conventions/information-architecture-guidelines.md.

Documentation tree:
dev-docs/
  00-foundation/
  01-product/
  02-research/
  03-design/
  04-architecture/
  05-planning/
  06-delivery/
  07-quality/
  08-operations/
  09-user-docs/
  99-archive/
