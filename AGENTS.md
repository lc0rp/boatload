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
