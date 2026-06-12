import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const port = Number.parseInt(process.env.PORT || "4989", 10);
const base = `http://127.0.0.1:${port}`;
const validationRoot = await mkdtemp(path.join(tmpdir(), "desktop-linear-validate-"));
const dbPath = path.join(validationRoot, "desktop-linear.sqlite");
const eventsPath = path.join(validationRoot, "events.jsonl");
const codexTasksPath = path.join(validationRoot, "codex-tasks.jsonl");
let server = null;

try {
  server = startServer();
  await waitForServer(server);
  await validateNewIssueDialog();

  await post("/api/projects", { slug: "VAL", name: "Validation Project" });
  const created = await post("/api/issues", {
    project_slug: "VAL",
    title: "Validate Desktop Linear lifecycle",
    description: "Exercise project IDs, state transitions, comments, GitHub events, and Codex queue.",
    labels: ["Desktop Symphony"],
    branch: "VAL-1-validation"
  });
  const issue = created.issue;
  assert(issue.key === "VAL-1", "expected project-scoped auto-increment key");
  assert(issue.proposed_action?.label, "expected proposed action");
  let sorted = await post("/api/settings", { sort_direction: "asc", project_slug: "VAL" });
  assert(sorted.app.sort_direction === "asc", "expected sort direction to persist through settings API");

  await post(`/api/issues/${issue.issue_id}/status`, { status: "backlog", project_slug: "VAL" });
  let model = await getModel("VAL");
  let card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.status === "backlog", "expected Backlog status to persist");
  assert(card.proposed_action?.label === "Prioritize", "expected Backlog proposed action");

  await post(`/api/issues/${issue.issue_id}/status`, { status: "in_progress", project_slug: "VAL" });
  await post(`/api/issues/${issue.issue_id}/comment`, { body: "Worktree prepared and worker assigned.", project_slug: "VAL" });
  await post(`/api/symphony/issues/${issue.key}/assignment`, {
    agent_id: "agent-validation",
    agent_nickname: "Validation Worker",
    worktree: "/tmp/desktop-linear-validation",
    branch: "VAL-1-validation",
    base: "origin/main"
  });
  await post(`/api/symphony/issues/${issue.key}/workpad`, {
    body: "## Codex Workpad\n\nDesktop Symphony Agent: pending\nDesktop Symphony Worktree: /tmp/desktop-linear-validation"
  });
  await post(`/api/symphony/issues/${issue.key}/workpad`, {
    body: "## Codex Workpad\n\nDesktop Symphony Agent: Validation Worker\nDesktop Symphony Worktree: /tmp/desktop-linear-validation"
  });
  await post(`/api/issues/${issue.issue_id}/talk`, { text: "draft: Worker should read the validation fixture and open a PR.", project_slug: "VAL" });
  model = await getModel("VAL");
  card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.status === "in_progress", "expected issue to stay in progress after draft command");
  assert(card.draft_response.includes("validation fixture"), "expected draft to persist");
  assert(card.assignee === "Validation Worker", "expected Symphony assignment to persist");
  assert(card.comments.some((comment) => comment.body.includes("Worktree prepared")), "expected comments to persist");
  assert(card.comments.some((comment) => comment.kind === "assignment"), "expected assignment comment to persist");
  const workpads = card.comments.filter((comment) => comment.kind === "workpad");
  assert(workpads.length === 1, "expected Symphony workpad upsert to update one comment");
  assert(workpads[0].body.includes("Validation Worker"), "expected Symphony workpad body to update");

  const symphonyQueue = await getSymphonyIssues("VAL", "in_progress");
  assert(symphonyQueue.cards.some((candidate) => candidate.key === "VAL-1"), "expected Symphony issue listing by state");

  await post(`/api/issues/${issue.issue_id}/talk`, { text: "ask Codex to inspect the validation state and suggest the next review step", project_slug: "VAL" });
  model = await getModel("VAL");
  card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.codex_tasks.some((task) => task.status === "queued"), "expected talk to queue a Codex task");

  await post("/api/github-events", {
    event_type: "opened",
    payload: {
      issue_key: "VAL-1",
      branch: "VAL-1-validation",
      pull_request: { html_url: "https://github.com/example/repo/pull/1", head: { ref: "VAL-1-validation" } }
    }
  });
  model = await getModel("VAL");
  card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.status === "code_review", "expected GitHub PR event to move issue to Code Review");
  assert(card.github_url.includes("/pull/1"), "expected GitHub URL to persist");

  await post(`/api/issues/${issue.issue_id}/status`, { status: "human_review", project_slug: "VAL" });
  await post(`/api/issues/${issue.issue_id}/status`, { status: "merging", project_slug: "VAL" });
  await post("/api/github-events", {
    event_type: "closed",
    payload: { issue_key: "VAL-1", merged: true, pull_request: { merged: true, html_url: "https://github.com/example/repo/pull/1" } }
  });

  server.kill("SIGTERM");
  server = startServer();
  await waitForServer(server);
  model = await getModel("VAL");
  assert(model.app.sort_direction === "asc", "expected sort direction to persist across restart");
  card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.status === "done", "expected state to persist across restart");
  assert(card.events.some((event) => event.type === "github_event_ingested"), "expected GitHub event in history");

  const events = await readFile(eventsPath, "utf8");
  assert(events.includes("issue_created") && events.includes("status_changed") && events.includes("codex_task_queued") && events.includes("github_event_ingested"), "expected append-only event log to record lifecycle");
  assert(events.includes("assignment_recorded"), "expected assignment event in append-only log");
  assert(events.includes("workpad_created") && events.includes("workpad_updated"), "expected workpad upsert events in append-only log");
  const codexTasks = await readFile(codexTasksPath, "utf8");
  assert(codexTasks.includes("next review step"), "expected Codex task queue mirror");

  console.log("Validation passed: project IDs, lifecycle states, comments, workpad upsert, talk-to-card Codex queue, GitHub events, restart persistence, and event log all work.");
} finally {
  if (server) server.kill("SIGTERM");
  await rm(validationRoot, { recursive: true, force: true });
}

function startServer() {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DESKTOP_LINEAR_DB: dbPath,
      DESKTOP_LINEAR_EVENTS: eventsPath,
      DESKTOP_LINEAR_CODEX_TASKS: codexTasksPath,
      CODEX_RUNS_DIR: path.join(validationRoot, "runs"),
      DISABLE_CODEX_EXEC: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk.toString());
  child.stderr.on("data", (chunk) => output += chunk.toString());
  child.output = () => output;
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/model`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not start. Output:\n${child.output()}`);
}

async function getModel(project) {
  const response = await fetch(`${base}/api/model?project=${encodeURIComponent(project)}`);
  assert(response.ok, `GET /api/model failed: ${response.status}`);
  return response.json();
}

async function getSymphonyIssues(project, states) {
  const response = await fetch(`${base}/api/symphony/issues?project=${encodeURIComponent(project)}&states=${encodeURIComponent(states)}`);
  assert(response.ok, `GET /api/symphony/issues failed: ${response.status}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert(response.ok, `POST ${url} failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function validateNewIssueDialog() {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert(html.includes('textarea name="issue" required'), "expected new issue dialog to use one required issue textarea");
  assert(!html.includes('name="title"') && !html.includes('name="description"'), "expected new issue dialog to remove separate title and description fields");
  assert(app.includes("deriveIssueFields"), "expected create flow to derive title and description from the issue textarea");
  assert(styles.includes(".issue-context { white-space: pre-wrap; }"), "expected issue context rendering to preserve newlines");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
