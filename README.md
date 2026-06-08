# Desktop Linear

Codex-native local issue tracker for Desktop Symphony projects.

## Run

```bash
npm start
```

Open `http://127.0.0.1:4888` in the Codex in-app browser.

To expose it on Tailscale from this Mac:

```bash
npm run start:tailscale
```

Open `http://100.64.0.1:4888` from another device on the tailnet.

For a persistent Mac service, load the LaunchAgent:

```bash
cp ops/com.example.desktop-linear.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.example.desktop-linear.plist
launchctl enable gui/501/com.example.desktop-linear
```

## Import From Linear

```bash
npm run import:linear -- --dry-run
npm run import:linear
```

The importer discovers current Desktop Symphony projects from
`/path/to/dev/*/.orchestration/*WORKFLOW.md` and
`/path/to/work/*/.orchestration/*WORKFLOW.md`, ignores generated
`symphony-workspaces`, then imports every Linear issue and comment for each
workflow's `tracker.project_slug`. Local project IDs stay project-scoped, such
as `BABEL-COPY-1`; the Linear `Project.slugId`, issue identifier, Linear URL,
and comment IDs are stored as source metadata for repeatable sync.

## State

- SQLite DB: `data/desktop-linear.sqlite`
- Append-only event log: `data/desktop-linear-events.jsonl`
- Codex task queue mirror: `data/desktop-linear-codex-tasks.jsonl`
- Codex run logs: `data/codex-task-runs/`

The SQLite database is the source of truth. The JSONL files are durable audit and integration surfaces for Codex-native work.

## Desktop Symphony Fit

Desktop Linear implements the issue-tracking subset Desktop Symphony needs:

- project-scoped auto-incrementing issue keys such as `DL-1`;
- lifecycle states: `Backlog`, `Todo`, `In Progress`, `Rework`, `Code Review`, `Human Review`, `Merging`, `Done`, `Canceled`;
- comments and full event history;
- card-level Codex task handoff through `Talk To This Issue`;
- GitHub event ingestion through `POST /api/github-events`;
- filesystem-backed state that survives app restarts.

Desktop Symphony-oriented endpoints are key-based so an orchestrator can work
with `DL-1` without first resolving an internal row id:

- `GET /api/symphony/issues?project=DL&states=todo,rework,code_review`
- `POST /api/symphony/issues`
- `POST /api/symphony/issues/DL-1/status`
- `POST /api/symphony/issues/DL-1/comment`
- `POST /api/symphony/issues/DL-1/workpad`
- `POST /api/symphony/issues/DL-1/assignment`

## Validation

```bash
npm run validate
```

The validation starts the app on a test port, creates a project and issue, moves the issue through Symphony states, adds comments, queues a card talk task, ingests a GitHub PR event, restarts the app against the same SQLite DB, and verifies persistence plus the append-only event log.
