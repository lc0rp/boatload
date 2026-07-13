# Boatload - Local shared tracker for bot orchestration

Think linear but stripped down, local, or self hosted. A building block in agent orchestration, with an API ready for a [symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)-like workflow. "Desktop Symphony" below refers to my set of workflows, skills, protocols and scripts that implement my custom version of Open AI's Symphony workflow.

I needed to set up autonomous workflows where I (or a review aagent) created tasks that an orchestration agent could route to a swarm of workers, while still allowing me to check-in, review work, approve PRs, etc.

## Run

```bash
npm start
```

This launches a local webserver reachable via `http://127.0.0.1:4888`.

Copy the environment template before configuring machine-specific paths or credentials:

```bash
cp .env.example .env
set -a
source .env
set +a
npm start
```

Update the .env to configure `LINEAR_API_KEY`, local database paths, project roots, and externally reachable service URLs.

## Import From Linear

I started using Linear but it was overkill for my individual and small team project needs. The importer allowed me to copy projects and tasks from Linear to Boatload.

```bash
npm run import:linear -- --dry-run
npm run import:linear
```

The importer discovers projects from the directories in
`DESKTOP_LINEAR_PROJECT_ROOTS`, finds `.orchestration/*WORKFLOW.md`, ignores generated
`symphony-workspaces`, then imports every issue and comment for each
workflow's `tracker.project_slug`. Local project IDs stay project-scoped, such
as `BABEL-COPY-1`; the Linear `Project.slugId`, issue identifier, Linear URL,
and comment IDs are stored as source metadata for repeatable sync.

## State

- SQLite DB: `data/desktop-linear.sqlite`
- Append-only event log: `data/desktop-linear-events.jsonl`
- Codex task queue mirror: `data/desktop-linear-codex-tasks.jsonl`
- Codex run logs: `data/codex-task-runs/`

The SQLite database stores issues, statuses, comments, notes, history and any other task-related info that isn't in git. The JSONL files provide audit and integration interfaces for Codex-based agents.

## Desktop Symphony Fit

Desktop Linear implements the issue-tracking subset Desktop Symphony needs:

- project-scoped auto-incrementing issue keys such as `DL-1`;
- lifecycle states: `Backlog`, `Todo`, `In Progress`, `Rework`, `Code Review`, `Human Review`, `Merging`, `Done`, `Canceled`;
- comments and full event history;
- card-level Codex task handoff through `Talk To This Issue`;
- GitHub event ingestion through `POST /api/github-events`;
- filesystem-backed state that survives app restarts.
- project-level `Nudge Project` links that open a new Codex thread with the
  selected project context and the `nudge always` prompt for checking,
  unpausing, and immediately running the project's automation.

Desktop Symphony-oriented endpoints are key-based so an orchestrator can work
with `DL-1` without first resolving an internal row id:

- `POST /api/projects` with `slug`, `name`, `description`, `source_repo`, and
  `workflow_path`
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
