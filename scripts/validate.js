import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseProjectCandidate, projectCreateLabel } from "../public/project-selector.js";
import { HISTORY_PAGE_SIZE, clampHistoryPage, historyPageItems, latestHistoryPage, mergedHistoryItems } from "../public/history.js";
import { runInNewContext } from "node:vm";

const port = Number.parseInt(process.env.PORT || "4989", 10);
const base = `http://127.0.0.1:${port}`;
const validationRoot = await mkdtemp(path.join(tmpdir(), "desktop-linear-validate-"));
const dbPath = path.join(validationRoot, "desktop-linear.sqlite");
const eventsPath = path.join(validationRoot, "events.jsonl");
const codexTasksPath = path.join(validationRoot, "codex-tasks.jsonl");
let server = null;
let model = null;
let card = null;

try {
  server = startServer();
  await waitForServer(server);
  await validateNewIssueDialog();

  await post("/api/projects", { slug: "VAL", name: "Validation Project" });
  assert(projectCreateLabel(parseProjectCandidate("New Project")) === "Create \"New Project, NEW\"", "expected project selector to guess a three-letter project stub");
  assert(projectCreateLabel(parseProjectCandidate("Customer Ops, COPS")) === "Create \"Customer Ops, COPS\"", "expected project selector to keep an explicit typed project stub");
  await post("/api/projects", { slug: "ALT", name: "Alternate Project" });
  const created = await post("/api/issues", {
    project_slug: "VAL",
    title: "Validate Desktop Linear lifecycle",
    description: "Exercise project IDs, state transitions, comments, GitHub events, and Codex queue.",
    labels: ["Desktop Symphony"],
    branch: "VAL-1-validation"
  });
  const issue = created.issue;
  assert(issue.key === "VAL-1", "expected project-scoped auto-increment key");
  assert(issue.status === "backlog", "expected new issues without explicit status to start in Backlog");
  assert(issue.proposed_action?.label, "expected proposed action");
  assert(issue.proposed_action?.label === "Prioritize", "expected Backlog proposed action on default issue");

  const explicitTodo = await post("/api/issues", {
    project_slug: "VAL",
    title: "Validate explicit Todo creation",
    description: "Exercise explicit status creation.",
    status: "todo"
  });
  assert(explicitTodo.issue.key === "VAL-2", "expected second project-scoped issue key");
  assert(explicitTodo.issue.status === "todo", "expected explicit Todo status to persist on creation");

  let sorted = await post("/api/settings", { sort_direction: "asc", project_slug: "VAL" });
  assert(sorted.app.sort_direction === "asc", "expected sort direction to persist through settings API");
  let activeProject = await post("/api/settings", { active_project_slug: "ALT" });
  assert(activeProject.app.active_project_slug === "ALT", "expected active project setting response");
  let model = await getModel("");
  assert(model.app.active_project_slug === "ALT", "expected active project to persist for no-query refresh");
  model = await getModel("VAL");
  assert(model.app.active_project_slug === "VAL", "expected explicit project query to override remembered project");

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
  assert(card.stage === "codex", "expected queued Codex task to expose the Codex stage");
  assert(card.stage_label === "Codex", "expected queued Codex task stage label");
  assert(model.stats.codex === 1, "expected Codex stage counter to include queued task");
  const codexStageQueue = await getSymphonyIssues("VAL", "codex");
  assert(codexStageQueue.cards.some((candidate) => candidate.key === "VAL-1"), "expected Symphony issue listing to filter by Codex stage");

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
  model = await getModel("");
  assert(model.app.active_project_slug === "ALT", "expected active project setting to persist across restart");
  model = await getModel("VAL");
  assert(model.app.sort_direction === "asc", "expected sort direction to persist across restart");
  const appBundle = await getText("/app.js");
  assert(appBundle.includes("historySortToggle") && appBundle.includes("history-sort-toggle"), "expected served app bundle to include History sort control");
  card = model.cards.find((candidate) => candidate.key === "VAL-1");
  assert(card.status === "done", "expected state to persist across restart");
  assert(card.events.some((event) => event.type === "github_event_ingested"), "expected GitHub event in history");

  const events = await readFile(eventsPath, "utf8");
  assert(events.includes("issue_created") && events.includes("status_changed") && events.includes("codex_task_queued") && events.includes("github_event_ingested"), "expected append-only event log to record lifecycle");
  assert(events.includes("assignment_recorded"), "expected assignment event in append-only log");
  assert(events.includes("workpad_created") && events.includes("workpad_updated"), "expected workpad upsert events in append-only log");
  const codexTasks = await readFile(codexTasksPath, "utf8");
  assert(codexTasks.includes("next review step"), "expected Codex task queue mirror");

  await installFakeCodex();
  server.kill("SIGTERM");
  server = startServer({
    CODEX_BINARY: "codex",
    DISABLE_CODEX_EXEC: "",
    HOME: validationRoot,
    PATH: "/usr/bin:/bin"
  });
  await waitForServer(server);
  await post(`/api/issues/${explicitTodo.issue.issue_id}/talk`, { text: "ask Codex to prove the runner can launch from a common local bin path", project_slug: "VAL" });
  const completedCodexCard = await waitForCodexResult("VAL", "VAL-2", "Fake Codex completed validation task.");
  assert(completedCodexCard.status === "todo", "expected Codex completion not to force a status transition");
  assert(completedCodexCard.stage === "todo", "expected completed Codex task to return to the lifecycle stage");

  validateHistoryPagination();
  await validateHistoryLinks();

  console.log("Validation passed: project IDs, lifecycle states, comments, workpad upsert, clickable paginated history, talk-to-card Codex queue, GitHub events, restart persistence, remembered active project, and event log all work.");
} finally {
  if (server) server.kill("SIGTERM");
  await rm(validationRoot, { recursive: true, force: true });
}

async function validateHistoryLinks() {
  const element = {
    dataset: {},
    value: "",
    classList: { toggle() {} },
    addEventListener() {},
    querySelector() { return element; },
    querySelectorAll() { return []; },
    setAttribute() {},
    focus() {},
    close() {},
    showModal() {},
    contains() { return false; },
    scrollIntoView() {}
  };
  const sandbox = {
    __DESKTOP_LINEAR_TESTS__: {},
    document: {
      activeElement: null,
      addEventListener() {},
      querySelector() { return element; }
    },
    Element: class Element {},
    fetch: async () => ({
      json: async () => ({
        app: { active_project_slug: "VAL", sort_direction: "desc" },
        projects: [{ slug: "VAL", name: "Validation Project" }],
        stats: { open: 0, backlog: 0, todo: 0, in_progress: 0, rework: 0, code_review: 0, human_review: 0, merging: 0, done: 0, total: 0 },
        cards: []
      })
    }),
    FormData,
    HISTORY_PAGE_SIZE,
    clampHistoryPage,
    findProject: (projects, value) => projects.find((project) => project.slug === value || `${project.slug} - ${project.name}` === value),
    historyPageItems,
    latestHistoryPage,
    mergedHistoryItems,
    Intl,
    localStorage: { getItem() { return ""; }, setItem() {} },
    parseProjectCandidate: () => null,
    projectCreateLabel: () => "",
    projectDisplayName: (project) => project ? `${project.slug} - ${project.name}` : "",
    URL,
    URLSearchParams,
    window: {
      location: { href: "http://127.0.0.1:4888/?project=VAL", search: "?project=VAL" },
      history: { replaceState() {} }
    },
    console
  };
  sandbox.globalThis = sandbox;
  const appScript = (await readFile(path.join(new URL("..", import.meta.url).pathname, "public", "app.js"), "utf8"))
    .replace('import { findProject, parseProjectCandidate, projectCreateLabel, projectDisplayName } from "./project-selector.js";', "")
    .replace('import { HISTORY_PAGE_SIZE, clampHistoryPage, historyPageItems, latestHistoryPage, mergedHistoryItems } from "./history.js";', "");
  runInNewContext(appScript, sandbox);
  const historyHtml = sandbox.__DESKTOP_LINEAR_TESTS__.historyHtml;
  assert(typeof historyHtml === "function", "expected history renderer test hook");
  const html = historyHtml({
    events: [{ created_at: "2026-01-01T00:00:00.000Z", actor: "GitHub", summary: "Opened https://github.com/example/repo/pull/1." }],
    comments: [{ created_at: "2026-01-01T00:01:00.000Z", author: "User", body: "Review <script>alert(1)</script> at https://linear.app/test" }]
  });
  assert(html.includes('<a href="https://github.com/example/repo/pull/1" target="_blank" rel="noreferrer">https://github.com/example/repo/pull/1</a>.'), "expected history URL with trailing punctuation to become a link");
  assert(html.includes('<a href="https://linear.app/test" target="_blank" rel="noreferrer">https://linear.app/test</a>'), "expected comment URL to become a link");
  assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "expected unsafe history text to remain escaped");
  assert(!html.includes("<script>"), "expected history renderer not to emit script tags");
}

async function installFakeCodex() {
  const fakeCodexDir = path.join(validationRoot, ".local", "bin");
  const fakeCodexPath = path.join(fakeCodexDir, "codex");
  await mkdir(fakeCodexDir, { recursive: true });
  await writeFile(fakeCodexPath, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";
process.stdin.resume();
process.stdin.on("end", () => {
  if (outputPath) fs.writeFileSync(outputPath, "Fake Codex completed validation task.");
});
`, "utf8");
  await chmod(fakeCodexPath, 0o755);
}

function startServer(envOverrides = {}) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DESKTOP_LINEAR_DB: dbPath,
      DESKTOP_LINEAR_EVENTS: eventsPath,
      DESKTOP_LINEAR_CODEX_TASKS: codexTasksPath,
      CODEX_RUNS_DIR: path.join(validationRoot, "runs"),
      DISABLE_CODEX_EXEC: "1",
      ...envOverrides
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

async function waitForCodexResult(project, key, expectedText) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const model = await getModel(project);
    const card = model.cards.find((candidate) => candidate.key === key);
    if (card?.comments.some((comment) => comment.kind === "codex_result" && comment.body.includes(expectedText))) return card;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Codex result on ${key}. Server output:\n${server?.output?.() || ""}`);
}

async function getText(url) {
  const response = await fetch(`${base}${url}`);
  assert(response.ok, `GET ${url} failed: ${response.status}`);
  return response.text();
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

function validateHistoryPagination() {
  const card = {
    events: Array.from({ length: 11 }, (_, index) => ({
      created_at: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      actor: "event",
      summary: `event-${index}`
    })),
    comments: Array.from({ length: 2 }, (_, index) => ({
      created_at: `2026-01-01T00:${String(index + 11).padStart(2, "0")}:00.000Z`,
      author: "comment",
      body: `comment-${index}`
    }))
  };
  const items = mergedHistoryItems(card);
  assert(items.length === 13, "expected history merge to include events and comments");
  assert(latestHistoryPage(items.length) === 2, "expected 13 history items to produce two pages");
  assert(historyPageItems(items, latestHistoryPage(items.length)).length === 3, "expected latest history page to contain remaining newest items");
  assert(historyPageItems(items, 1).length === HISTORY_PAGE_SIZE, "expected first history page to contain 10 items");
  assert(clampHistoryPage(99, items.length) === 2, "expected high history page to clamp to last page");
  assert(clampHistoryPage(0, items.length) === 1, "expected low history page to clamp to first page");
}
