---
type: Concept
primary_audience: Operators
owner: Desktop Linear maintainers
last_verified: 2026-06-22
next_review_by: 2026-07-22
source_of_truth: ../../README.md
---

# Desktop Linear

Desktop Linear is a local issue tracker for agent-driven lifecycle work. It is not the public Linear service. Runtime paths and externally reachable URLs are supplied through environment variables.

## Start pages

- Operators: start with the environment template in the repository README.

## Workstreams

- Builders maintain the app code and Desktop Symphony API behavior.
- Testers run `npm run validate` after app or routing changes.
- Operators configure the local process manager or reverse proxy for their environment.
- Users open the URL configured by their operator.
