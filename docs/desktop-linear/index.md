---
type: Concept
primary_audience: Operators
owner: Desktop Linear maintainers
last_verified: 2026-06-22
next_review_by: 2026-07-22
source_of_truth: ../../ops/Caddyfile.devbox
---

# Desktop Linear

Desktop Linear is a local issue tracker for Desktop Symphony lifecycle work. It is not the public Linear service. On the devbox, browser traffic enters through Caddy and reaches the app through a local HTTP backend.

## Start pages

- Operators: [Run Desktop Linear through Caddy](./operators.md)

## Workstreams

- Builders maintain the app code and Desktop Symphony API behavior.
- Testers run `npm run validate` after app or routing changes.
- Operators keep the devbox Caddy route and backend service running.
- Users open Desktop Linear at `https://host.example.test/desktop-linear/`.
