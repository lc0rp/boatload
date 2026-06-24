import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants, accessSync, createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const runsDir = process.env.CODEX_RUNS_DIR || path.join(dataDir, "codex-task-runs");
const dbPath = process.env.DESKTOP_LINEAR_DB || path.join(dataDir, "desktop-linear.sqlite");
const eventsPath = process.env.DESKTOP_LINEAR_EVENTS || path.join(dataDir, "desktop-linear-events.jsonl");
const codexTasksPath = process.env.DESKTOP_LINEAR_CODEX_TASKS || path.join(dataDir, "desktop-linear-codex-tasks.jsonl");
const codexBinary = process.env.CODEX_BINARY || "codex";
const codexExecutable = resolveCodexExecutable(codexBinary);
const port = Number.parseInt(process.env.PORT || "4888", 10);
const host = process.env.HOST || "127.0.0.1";

const states = ["backlog", "todo", "in_progress", "rework", "code_review", "human_review", "merging", "done", "canceled"];
const openStates = new Set(["backlog", "todo", "in_progress", "rework", "code_review", "human_review", "merging"]);
const runningCodexTasks = new Set();
const workpadHeader = "## Codex Workpad";
const db = await openDb();

async function openDb() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await touch(eventsPath);
  await touch(codexTasksPath);
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(database);
  seed(database);
  return database;
}

async function touch(filePath) {
  try {
    await stat(filePath);
  } catch {
    await writeFile(filePath, "", "utf8");
  }
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal',
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignee TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      worktree TEXT NOT NULL DEFAULT '',
      github_url TEXT NOT NULL DEFAULT '',
      draft_response TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, number)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_tasks (
      id TEXT PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_events (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(database, "projects", "linear_slug_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "projects", "source_repo", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "projects", "workflow_path", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "issues", "linear_issue_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "issues", "linear_identifier", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "issues", "linear_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "issues", "linear_state", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "issues", "linear_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "comments", "linear_comment_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "comments", "updated_at", "TEXT NOT NULL DEFAULT ''");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_issue_id ON issues(linear_issue_id) WHERE linear_issue_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_linear_comment_id ON comments(linear_comment_id) WHERE linear_comment_id != '';
    CREATE INDEX IF NOT EXISTS idx_projects_linear_slug_id ON projects(linear_slug_id);
  `);
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seed(database) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM projects").get().count;
  if (count > 0) return;
  const now = iso();
  const project = createProject(database, { slug: "DL", name: "Desktop Linear", now, actor: "system" });
  createIssue(database, {
    project_slug: project.slug,
    title: "Replace Linear for Desktop Symphony lifecycle work",
    description: "Local tracker must support project IDs, comments, state transitions, GitHub events, and Codex-native card actions.",
    labels: ["Desktop Symphony"],
    actor: "system",
    now
  });
}

function createProject(database, body) {
  const now = body.now || iso();
  const slug = normalizeSlug(body.slug || body.name || "DL");
  const name = String(body.name || slug).trim();
  database.prepare("INSERT INTO projects (slug, name, next_number, created_at, updated_at) VALUES (?, ?, 1, ?, ?)").run(slug, name, now, now);
  const project = projectBySlug(database, slug);
  recordEvent(database, null, "project_created", body.actor || "User", `Project ${slug} created.`, { slug, name }, now);
  return project;
}

function createIssue(database, body) {
  const now = body.now || iso();
  const project = projectBySlug(database, body.project_slug || body.project || "DL") || createProject(database, { slug: body.project_slug || "DL", name: body.project_name || body.project_slug || "Desktop Linear", actor: body.actor, now });
  const number = project.next_number;
  const key = `${project.slug}-${number}`;
  database.prepare("UPDATE projects SET next_number = ?, updated_at = ? WHERE id = ?").run(number + 1, now, project.id);
  database.prepare(`
    INSERT INTO issues (project_id, number, key, title, description, status, priority, labels_json, assignee, branch, worktree, github_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    number,
    key,
    requiredText(body.title, "Issue title is required."),
    String(body.description || ""),
    normalizeStatus(body.status || "backlog"),
    String(body.priority || "normal"),
    JSON.stringify(asArray(body.labels)),
    String(body.assignee || ""),
    String(body.branch || ""),
    String(body.worktree || ""),
    String(body.github_url || ""),
    now,
    now
  );
  const issue = issueByKey(database, key);
  recordEvent(database, issue.id, "issue_created", body.actor || "User", `${key} created.`, body, now);
  return issue;
}

function loadModel(projectSlug = "") {
  const projects = db.prepare("SELECT * FROM projects ORDER BY slug").all();
  const activeProject = projectBySlug(db, projectSlug) || projectBySlug(db, getSetting("active_project_slug", "")) || projects[0] || null;
  const sortDirection = normalizedSortDirection(getSetting("sort_direction", "desc"));
  const orderDirection = sortDirection === "asc" ? "ASC" : "DESC";
  const rows = activeProject
    ? db.prepare(`SELECT i.*, p.slug AS project_slug, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.id = ? ORDER BY i.updated_at ${orderDirection}, i.id ${orderDirection}`).all(activeProject.id)
    : [];
  const cards = rows.map(toCard);
  return {
    generated_at: iso(),
    app: {
      db_path: dbPath,
      events_path: eventsPath,
      root_path: root,
      active_project_slug: activeProject?.slug || null,
      sort_direction: sortDirection
    },
    projects,
    stats: statsFor(cards),
    cards
  };
}

function getSetting(key, fallback = "") {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || fallback;
}

function setSetting(key, value) {
  const now = iso();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

function normalizedSortDirection(value) {
  return value === "asc" ? "asc" : "desc";
}

function toCard(row) {
  const comments = db.prepare("SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC").all(row.id);
  const events = db.prepare("SELECT * FROM events WHERE issue_id = ? ORDER BY created_at ASC, id ASC").all(row.id);
  const tasks = db.prepare("SELECT * FROM codex_tasks WHERE issue_id = ? ORDER BY created_at ASC").all(row.id);
  const stage = stageForStatus(row.status, tasks);
  const labels = parseJson(row.labels_json, []);
  return {
    id: String(row.id),
    issue_id: row.id,
    key: row.key,
    project_slug: row.project_slug,
    project_name: row.project_name,
    title: row.title,
    description: row.description,
    status: row.status,
    status_label: labelForStatus(row.status),
    priority: row.priority,
    labels,
    assignee: row.assignee,
    branch: row.branch,
    worktree: row.worktree,
    github_url: row.github_url,
    linear_identifier: row.linear_identifier || "",
    linear_url: row.linear_url || "",
    linear_state: row.linear_state || "",
    linear_updated_at: row.linear_updated_at || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    local_time: localTime(row.updated_at),
    summary: row.description || "No description yet.",
    stage,
    stage_label: labelForStatus(stage),
    proposed_action: proposedAction(row, labels, comments, tasks),
    comments,
    events: events.map((event) => ({ ...event, payload: parseJson(event.payload_json, {}) })),
    codex_tasks: tasks
  };
}

function proposedAction(issue, labels, comments, tasks) {
  const latestTask = tasks.at(-1);
  if (latestTask?.status === "working" || latestTask?.status === "queued") {
    return { type: "codex", label: "Wait for Codex", prompt: "Codex is already working this card. Review the result when it returns." };
  }
  if (issue.status === "backlog") return { type: "prioritize", label: "Prioritize", prompt: "Clarify scope and move to Todo when this is ready for Desktop Symphony dispatch." };
  if (issue.status === "todo") return { type: "dispatch", label: "Start work", prompt: "Move to In Progress, assign a worktree or branch, and hand the issue to a Codex worker if needed." };
  if (issue.status === "in_progress") return { type: "continue", label: "Continue or review", prompt: "Ask Codex for the next implementation step, or move to Code Review when the branch and PR are ready." };
  if (issue.status === "rework") return { type: "fix", label: "Address findings", prompt: "Review the latest comments and send the issue back through the same worker/worktree." };
  if (issue.status === "code_review") return { type: "review", label: "Run review", prompt: "Run a Desktop Symphony code review against the GitHub PR or branch, then move to Rework or Human Review." };
  if (issue.status === "human_review") return { type: "human", label: "Human decision", prompt: "Decide whether this is approved for merging or needs more rework." };
  if (issue.status === "merging") return { type: "land", label: "Land work", prompt: "Follow the repo landing flow, record the merge result, then move to Done." };
  if (issue.status === "done") return { type: "archive", label: "Review history", prompt: "Confirm the timeline is complete or add a closing note." };
  return { type: "triage", label: "Triage", prompt: "Clarify the desired outcome and move the issue to the right state." };
}

function stageForStatus(status, tasks) {
  const latestTask = tasks.at(-1);
  return latestTask?.status === "working" || latestTask?.status === "queued" ? "codex" : status;
}

function statsFor(cards) {
  const stats = { total: cards.length, open: 0, codex: 0 };
  for (const state of states) stats[state] = 0;
  for (const card of cards) {
    stats[card.status] = (stats[card.status] || 0) + 1;
    if (card.stage === "codex") stats.codex += 1;
    if (openStates.has(card.status)) stats.open += 1;
  }
  return stats;
}

function updateIssueStatus(id, body) {
  const issue = issueById(db, id);
  if (!issue) throw new Error("Issue not found.");
  const now = iso();
  const status = normalizeStatus(body.status);
  db.prepare("UPDATE issues SET status = ?, updated_at = ? WHERE id = ?").run(status, now, issue.id);
  const summary = `${issue.key} moved from ${labelForStatus(issue.status)} to ${labelForStatus(status)}.`;
  recordEvent(db, issue.id, "status_changed", body.actor || "User", summary, { from: issue.status, to: status }, now);
}

function addComment(issueId, body) {
  const issue = issueById(db, issueId);
  if (!issue) throw new Error("Issue not found.");
  const now = iso();
  const author = String(body.author || "User");
  const text = requiredText(body.body || body.text, "Comment body is required.");
  db.prepare("INSERT INTO comments (issue_id, author, body, kind, created_at) VALUES (?, ?, ?, ?, ?)").run(issue.id, author, text, String(body.kind || "comment"), now);
  db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
  recordEvent(db, issue.id, "comment_added", author, `${author} commented on ${issue.key}.`, { body: text }, now);
}

function upsertWorkpad(issueKey, body) {
  const issue = issueByKey(db, issueKey);
  if (!issue) throw new Error("Issue not found.");
  const now = iso();
  const author = String(body.author || "Desktop Symphony");
  const text = requiredText(body.body || body.text, "Workpad body is required.");
  const existing = db.prepare(`
    SELECT * FROM comments
    WHERE issue_id = ? AND (kind = 'workpad' OR body LIKE ?)
    ORDER BY id DESC
    LIMIT 1
  `).get(issue.id, `%${workpadHeader}%`);
  if (existing) {
    db.prepare("UPDATE comments SET author = ?, body = ?, kind = 'workpad', updated_at = ? WHERE id = ?").run(author, text, now, existing.id);
    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
    recordEvent(db, issue.id, "workpad_updated", author, `${issue.key} workpad updated.`, { comment_id: existing.id }, now);
    return { action: "updated", comment_id: existing.id };
  }
  db.prepare("INSERT INTO comments (issue_id, author, body, kind, created_at, updated_at) VALUES (?, ?, ?, 'workpad', ?, ?)").run(issue.id, author, text, now, now);
  const comment = db.prepare("SELECT * FROM comments WHERE issue_id = ? ORDER BY id DESC LIMIT 1").get(issue.id);
  db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
  recordEvent(db, issue.id, "workpad_created", author, `${issue.key} workpad created.`, { comment_id: comment.id }, now);
  return { action: "created", comment_id: comment.id };
}

function patchIssue(issueId, body) {
  const issue = issueById(db, issueId);
  if (!issue) throw new Error("Issue not found.");
  const now = iso();
  const actor = String(body.actor || "User");
  const textEdits = [];
  if (body.title !== undefined && body.title !== issue.title) textEdits.push("title");
  if (body.description !== undefined && body.description !== issue.description) textEdits.push("issue context");
  db.prepare(`
    UPDATE issues SET title = ?, description = ?, priority = ?, labels_json = ?, assignee = ?, branch = ?, worktree = ?, github_url = ?, updated_at = ? WHERE id = ?
  `).run(
    body.title ?? issue.title,
    body.description ?? issue.description,
    body.priority ?? issue.priority,
    JSON.stringify(body.labels ? asArray(body.labels) : parseJson(issue.labels_json, [])),
    body.assignee ?? issue.assignee,
    body.branch ?? issue.branch,
    body.worktree ?? issue.worktree,
    body.github_url ?? issue.github_url,
    now,
    issue.id
  );
  const summary = textEdits.length
    ? `Edited by ${actor}: ${issue.key} ${textEdits.join(" and ")} updated.`
    : `${issue.key} updated.`;
  recordEvent(db, issue.id, "issue_updated", actor, summary, body, now);
}

function assignIssue(issueKey, body) {
  const issue = issueByKey(db, issueKey);
  if (!issue) throw new Error("Issue not found.");
  const now = iso();
  const worktree = String(body.worktree || issue.worktree || "");
  const branch = String(body.branch || issue.branch || "");
  const assignee = String(body.agent_nickname || body.agent_id || body.assignee || issue.assignee || "");
  db.prepare("UPDATE issues SET assignee = ?, branch = ?, worktree = ?, updated_at = ? WHERE id = ?").run(assignee, branch, worktree, now, issue.id);
  const lines = [
    `Desktop Symphony Agent: ${assignee || "pending"}`,
    `Worktree: ${worktree || "unset"}`,
    `Branch: ${branch || "unset"}`,
    body.base ? `Base: ${body.base}` : ""
  ].filter(Boolean).join("\n");
  db.prepare("INSERT INTO comments (issue_id, author, body, kind, created_at) VALUES (?, 'Desktop Symphony', ?, 'assignment', ?)").run(issue.id, lines, now);
  recordEvent(db, issue.id, "assignment_recorded", body.actor || "Desktop Symphony", `${issue.key} assignment recorded.`, body, now);
}

async function handleTalk(issueId, body) {
  const issue = issueById(db, issueId);
  if (!issue) throw new Error("Issue not found.");
  const text = String(body.text || "").trim();
  if (!text) return recordEvent(db, issue.id, "empty_talk", "User", "Empty talk turn ignored.", {}, iso());
  addComment(issue.id, { author: "User", body: text, kind: "talk" });
  const status = statusFromTalk(text);
  if (status) {
    updateIssueStatus(issue.id, { status, actor: "User" });
    return;
  }
  const comment = text.match(/^(comment|note)\s*:\s*(.+)$/i);
  if (comment?.[2]) {
    addComment(issue.id, { author: "User", body: comment[2], kind: "comment" });
    return;
  }
  await createCodexTask(issue.id, text);
}

async function createCodexTask(issueId, text) {
  const issue = issueById(db, issueId);
  const now = iso();
  const id = `codex-${now.replaceAll(/[^0-9A-Za-z]/g, "")}`;
  db.prepare("INSERT INTO codex_tasks (id, issue_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)").run(id, issue.id, text, now, now);
  recordEvent(db, issue.id, "codex_task_queued", "User", `Codex task queued for ${issue.key}.`, { task_id: id, text }, now);
  await appendFile(codexTasksPath, `${JSON.stringify({ id, issue_id: issue.id, issue_key: issue.key, text, status: "queued", created_at: now })}\n`, "utf8");
  triggerCodexTask(id).catch((error) => console.error(`Failed to launch Codex task ${id}:`, error));
}

async function triggerPendingCodexTasks() {
  if (process.env.DISABLE_CODEX_EXEC === "1") return;
  for (const task of db.prepare("SELECT * FROM codex_tasks WHERE status = 'queued'").all()) {
    await triggerCodexTask(task.id);
  }
}

async function triggerCodexTask(taskId) {
  if (process.env.DISABLE_CODEX_EXEC === "1" || runningCodexTasks.has(taskId)) return;
  const task = db.prepare("SELECT * FROM codex_tasks WHERE id = ?").get(taskId);
  if (!task || task.status !== "queued") return;
  runningCodexTasks.add(taskId);
  const now = iso();
  db.prepare("UPDATE codex_tasks SET status = 'working', updated_at = ? WHERE id = ?").run(now, taskId);
  recordEvent(db, task.issue_id, "codex_task_started", "app", `Codex started task ${taskId}.`, { task_id: taskId }, now);
  await launchCodexCli(task);
}

async function launchCodexCli(task) {
  const issueRow = issueById(db, task.issue_id);
  const project = projectById(db, issueRow.project_id);
  const issue = toCard({ ...issueRow, project_slug: project.slug, project_name: project.name });
  const workspace = codexWorkspaceFor(issue);
  const apiBase = process.env.DESKTOP_LINEAR_API_BASE || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const prompt = `You are working a Desktop Linear card inside Codex Desktop.

Workspace: ${workspace}
App API base: ${apiBase}
Issue: ${issue.key}
Task id: ${task.id}
User's instruction: ${task.text}

Issue context:
${JSON.stringify(issue, null, 2)}

Rules:
- Interpret the instruction in context.
- Use live sources when current facts matter.
- Write durable output back to the app before finishing.
- To finish, POST JSON to /api/issues/${issue.id}/codex-result with {"task_id":"${task.id}","result":"<concise result>"}.
- If a state transition is right, POST /api/issues/${issue.id}/status first or set "status" in the result payload to a Desktop Linear state.
`;
  const base = path.join(runsDir, task.id);
  const promptPath = `${base}.prompt.md`;
  const stdoutPath = `${base}.stdout.log`;
  const stderrPath = `${base}.stderr.log`;
  const resultPath = `${base}.last-message.md`;
  await writeFile(promptPath, prompt, "utf8");
  const args = ["exec", "--cd", workspace, "--skip-git-repo-check", "--sandbox", "danger-full-access", "--output-last-message", resultPath, "-"];
  if (process.env.CODEX_EXEC_MODEL) args.splice(-1, 0, "--model", process.env.CODEX_EXEC_MODEL);
  const child = spawn(codexExecutable, args, { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(prompt);
  child.stdout.pipe(createWriteStream(stdoutPath, { flags: "a" }));
  child.stderr.pipe(createWriteStream(stderrPath, { flags: "a" }));
  child.on("close", async (code) => {
    runningCodexTasks.delete(task.id);
    const current = db.prepare("SELECT * FROM codex_tasks WHERE id = ?").get(task.id);
    if (!current || current.status === "done") return;
    const result = code === 0 ? (await readText(resultPath)) || "Codex CLI completed." : `Codex CLI exited with code ${code}. See ${stderrPath}.`;
    completeCodexTask(task.issue_id, { task_id: task.id, result });
  });
  child.on("error", (error) => {
    runningCodexTasks.delete(task.id);
    completeCodexTask(task.issue_id, { task_id: task.id, result: `Codex task failed: ${error.message}` });
  });
}

function codexWorkspaceFor(issue) {
  if (issue.worktree && existsSync(issue.worktree)) return issue.worktree;
  return root;
}

function resolveCodexExecutable(value) {
  const executable = String(value || "codex");
  if (executable.includes(path.sep)) return executable;
  const home = process.env.HOME || "";
  const candidates = [
    ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, executable)),
    home ? path.join(home, ".local", "bin", executable) : "",
    home ? path.join(home, ".npm-global", "bin", executable) : "",
    home ? path.join(home, ".bun", "bin", executable) : "",
    path.join("/opt/homebrew/bin", executable),
    path.join("/usr/local/bin", executable),
    path.join("/usr/bin", executable)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return executable;
}

function completeCodexTask(issueId, body) {
  const issue = issueById(db, issueId);
  const taskId = String(body.task_id || "");
  const now = iso();
  const result = String(body.result || "Codex completed the requested work.").trim();
  if (taskId) db.prepare("UPDATE codex_tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ?").run(result, now, taskId);
  addComment(issue.id, { author: "Codex", body: result, kind: "codex_result" });
  if (body.status && states.includes(body.status)) updateIssueStatus(issue.id, { status: body.status, actor: "Codex" });
  recordEvent(db, issue.id, "codex_task_completed", "Codex", `Codex completed ${taskId || "a task"} for ${issue.key}.`, { task_id: taskId, result }, now);
}

function ingestGithubEvent(body) {
  const now = iso();
  const payload = body.payload || body;
  const eventType = String(body.event_type || payload.action || payload.event || "github_event");
  const issue = resolveIssueFromGithub(payload);
  db.prepare("INSERT INTO github_events (issue_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(issue?.id || null, eventType, JSON.stringify(payload), now);
  if (!issue) {
    recordEvent(db, null, "github_event_unmatched", "github", "GitHub event did not match a Desktop Linear issue.", payload, now);
    return;
  }
  const pr = payload.pull_request || payload.pr || {};
  const patch = {};
  if (pr.html_url || payload.github_url) patch.github_url = pr.html_url || payload.github_url;
  if (pr.head?.ref || payload.branch) patch.branch = pr.head?.ref || payload.branch;
  if (Object.keys(patch).length) patchIssue(issue.id, { ...patch, actor: "github" });
  if (["opened", "synchronize", "ready_for_review"].includes(eventType)) updateIssueStatus(issue.id, { status: "code_review", actor: "github" });
  if (eventType === "closed" && (pr.merged || payload.merged)) updateIssueStatus(issue.id, { status: "done", actor: "github" });
  recordEvent(db, issue.id, "github_event_ingested", "github", `GitHub ${eventType} ingested for ${issue.key}.`, payload, now);
}

function resolveIssueFromGithub(payload) {
  const key = payload.issue_key || payload.key || payload.issue?.key;
  if (key) return issueByKey(db, key);
  const branch = payload.branch || payload.pull_request?.head?.ref || payload.pr?.head?.ref || "";
  if (!branch) return null;
  const keyMatch = branch.match(/[A-Z][A-Z0-9]*-\d+/);
  if (keyMatch) return issueByKey(db, keyMatch[0]);
  return db.prepare("SELECT * FROM issues WHERE branch = ?").get(branch) || null;
}

function recordEvent(database, issueId, type, actor, summary, payload = {}, now = iso()) {
  database.prepare("INSERT INTO events (issue_id, type, actor, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(issueId, type, actor, summary, JSON.stringify(payload), now);
  appendFile(eventsPath, `${JSON.stringify({ issue_id: issueId, type, actor, summary, payload, created_at: now })}\n`, "utf8").catch((error) => console.error("Event log append failed:", error));
}

function projectBySlug(database, slug) {
  if (!slug) return null;
  return database.prepare("SELECT * FROM projects WHERE slug = ?").get(normalizeSlug(slug)) || null;
}
function projectById(database, id) {
  return database.prepare("SELECT * FROM projects WHERE id = ?").get(id) || null;
}
function issueById(database, id) {
  return database.prepare("SELECT * FROM issues WHERE id = ?").get(Number(id)) || null;
}
function issueByKey(database, key) {
  return database.prepare("SELECT * FROM issues WHERE key = ?").get(String(key || "").toUpperCase()) || null;
}

function statusFromTalk(text) {
  const lower = text.toLowerCase();
  const match = lower.match(/\b(?:move|mark|status|transition)\b.*\b(backlog|todo|to do|in progress|progress|rework|code review|review|human review|merging|merge|done|cancel|canceled)\b/);
  if (!match) return "";
  return normalizeStatus(match[1]);
}
function normalizeStatus(value) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const aliases = { to_do: "todo", progress: "in_progress", review: "code_review", merge: "merging", cancel: "canceled" };
  const status = aliases[normalized] || normalized;
  if (!states.includes(status)) throw new Error(`Invalid status: ${value}`);
  return status;
}
function labelForStatus(status) {
  return String(status).split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}
function normalizeSlug(value) {
  return String(value || "DL").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "DL";
}
function asArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}
function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}
function iso() {
  return new Date().toISOString();
}
function localTime(value) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
async function readText(filePath) {
  try { return (await readFile(filePath, "utf8")).trim(); } catch { return ""; }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function serveStatic(req, res) {
  const rawPath = new URL(req.url, `http://${host}:${port}`).pathname;
  const safePath = rawPath === "/" ? "/index.html" : rawPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return sendError(res, 403, "Forbidden");
  try {
    await stat(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendError(res, 404, "Not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (req.method === "GET" && url.pathname === "/api/model") return sendJson(res, 200, loadModel(url.searchParams.get("project") || ""));
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readBody(req);
    if (body.sort_direction !== undefined) setSetting("sort_direction", normalizedSortDirection(body.sort_direction));
    const activeProjectSlug = body.active_project_slug ?? body.project_slug;
    if (activeProjectSlug !== undefined) {
      const project = projectBySlug(db, activeProjectSlug);
      if (!project) return sendError(res, 400, "Project not found.");
      setSetting("active_project_slug", project.slug);
    }
    return sendJson(res, 200, loadModel(activeProjectSlug || body.project_slug || ""));
  }
  if (req.method === "GET" && url.pathname === "/api/symphony/issues") {
    const project = url.searchParams.get("project") || "";
    const stateFilter = new Set(String(url.searchParams.get("states") || "").split(",").map((item) => item.trim()).filter(Boolean));
    const cards = loadModel(project).cards.filter((card) => !stateFilter.size || stateFilter.has(card.status) || stateFilter.has(card.stage));
    return sendJson(res, 200, { generated_at: iso(), cards });
  }
  if (req.method === "POST" && url.pathname === "/api/symphony/issues") {
    const body = await readBody(req);
    const issue = createIssue(db, { ...body, actor: body.actor || "Desktop Symphony" });
    return sendJson(res, 200, toCard({ ...issue, project_slug: projectById(db, issue.project_id).slug, project_name: projectById(db, issue.project_id).name }));
  }
  const symphonyRoute = url.pathname.match(/^\/api\/symphony\/issues\/([^/]+)\/([^/]+)$/);
  if (req.method === "POST" && symphonyRoute) {
    const [, key, action] = symphonyRoute;
    const issue = issueByKey(db, decodeURIComponent(key));
    if (!issue) return sendError(res, 404, "Issue not found");
    const body = await readBody(req);
    if (action === "status") updateIssueStatus(issue.id, { ...body, actor: body.actor || "Desktop Symphony" });
    else if (action === "comment") addComment(issue.id, { ...body, author: body.author || "Desktop Symphony" });
    else if (action === "workpad") upsertWorkpad(issue.key, { ...body, author: body.author || "Desktop Symphony" });
    else if (action === "assignment") assignIssue(issue.key, body);
    else return sendError(res, 404, "Unknown Symphony issue action");
    const project = projectById(db, issue.project_id);
    return sendJson(res, 200, toCard({ ...issueById(db, issue.id), project_slug: project.slug, project_name: project.name }));
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readBody(req);
    createProject(db, body);
    return sendJson(res, 200, loadModel(body.slug));
  }
  if (req.method === "POST" && url.pathname === "/api/issues") {
    const body = await readBody(req);
    const issue = createIssue(db, body);
    return sendJson(res, 200, { issue: toCard({ ...issue, project_slug: projectById(db, issue.project_id).slug, project_name: projectById(db, issue.project_id).name }), model: loadModel(body.project_slug) });
  }
  const issueRoute = url.pathname.match(/^\/api\/issues\/([^/]+)\/([^/]+)$/);
  if (req.method === "POST" && issueRoute) {
    const [, id, action] = issueRoute;
    const body = await readBody(req);
    if (action === "status") updateIssueStatus(id, body);
    else if (action === "comment") addComment(id, body);
    else if (action === "patch") patchIssue(id, body);
    else if (action === "talk") await handleTalk(id, body);
    else if (action === "codex-result") completeCodexTask(id, body);
    else return sendError(res, 404, "Unknown issue action");
    return sendJson(res, 200, loadModel(body.project_slug || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/github-events") {
    ingestGithubEvent(await readBody(req));
    return sendJson(res, 200, loadModel());
  }
  return sendError(res, 404, "Unknown API route");
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message);
  }
});

server.listen(port, host, () => {
  console.log(`Desktop Linear running at http://${host}:${port}`);
  triggerPendingCodexTasks().catch((error) => console.error("Codex task scan failed:", error));
  if (process.env.DISABLE_CODEX_EXEC !== "1") {
    setInterval(() => triggerPendingCodexTasks().catch((error) => console.error("Codex task scan failed:", error)), 15000).unref();
  }
});
