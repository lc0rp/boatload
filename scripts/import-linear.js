import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const runtimeEnv = { ...readEnvFileSync(path.join(root, ".env")), ...process.env };
const dbPath = runtimeEnv.DESKTOP_LINEAR_DB || path.join(dataDir, "desktop-linear.sqlite");
const eventsPath = runtimeEnv.DESKTOP_LINEAR_EVENTS || path.join(dataDir, "desktop-linear-events.jsonl");
const linearUrl = "https://api.linear.app/graphql";
const laneSuffixes = new Set(["small", "medium", "large", "urgent", "high", "low"]);

let dryRun = false;
let apiKey = "";
let db = null;

async function main() {
  const args = new Set(process.argv.slice(2));
  dryRun = args.has("--dry-run");
  const discovered = await discoverProjects();
  apiKey = loadLinearApiKey();
  if (!apiKey) throw new Error("Missing LINEAR_API_KEY in repo .env, ~/.agents/.env, process env, or Infisical.");

  await mkdir(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);

  const report = {
    dry_run: dryRun,
    discovered_projects: discovered.map(({ slug, name, linear_slug_id, source_repo, workflow_path, history_hits }) => ({ slug, name, linear_slug_id, source_repo, workflow_path, history_hits })),
    imported: []
  };

  for (const project of discovered) {
    const linear = await fetchLinearProject(project.linear_slug_id);
    const result = dryRun ? summarizeLinearProject(project, linear) : await importProject(project, linear);
    report.imported.push(result);
    console.log(`${dryRun ? "Would import" : "Imported"} ${result.slug}: ${result.issue_count} issues, ${result.comment_count} comments`);
  }

  await writeFile(path.join(dataDir, "linear-import-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report: ${path.join(dataDir, "linear-import-report.json")}`);
}

async function discoverProjects() {
  const workflowPaths = findWorkflowPaths();
  const byLinearSlug = new Map();
  for (const workflowPath of workflowPaths) {
    if (workflowPath.includes("/symphony-workspaces/")) continue;
    const text = await readFile(workflowPath, "utf8");
    const linearSlugId = matchScalar(text, "project_slug");
    if (!linearSlugId) continue;
    const workflowSlug = localSlugFromWorkflow(workflowPath);
    const existing = byLinearSlug.get(linearSlugId);
    const candidate = {
      slug: normalizeSlug(workflowSlug),
      name: titleFromSlug(workflowSlug),
      linear_slug_id: linearSlugId,
      source_repo: repoFromWorkflow(workflowPath),
      workflow_path: workflowPath,
      history_hits: historyHits(linearSlugId)
    };
    if (!existing || existing.workflow_path.includes("/symphony-workspaces/")) byLinearSlug.set(linearSlugId, candidate);
  }
  return [...byLinearSlug.values()].sort((a, b) => developer-machine.localeCompare(b.slug));
}

function findWorkflowPaths() {
  const roots = String(runtimeEnv.DESKTOP_LINEAR_PROJECT_ROOTS || `${path.join(os.homedir(), "dev")}${path.delimiter}${path.join(os.homedir(), "work")}`)
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const found = [];
  for (const base of roots) {
    try {
      const output = execFileSync("find", [base, "-maxdepth", "5", "-path", "*/.orchestration/*WORKFLOW.md", "-print"], { encoding: "utf8" });
      found.push(...output.split("\n").filter(Boolean));
    } catch {}
  }
  return found.sort();
}

function historyHits(linearSlugId) {
  try {
    const sessionsDir = runtimeEnv.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions");
    const output = execFileSync("rg", ["-l", linearSlugId, sessionsDir], { encoding: "utf8", timeout: 15000 });
    return output.split("\n").filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

function matchScalar(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m"));
  return match?.[1]?.trim() || "";
}

function localSlugFromWorkflow(workflowPath) {
  let name = path.basename(workflowPath);
  if (name.endsWith(".WORKFLOW.md")) name = name.slice(0, -".WORKFLOW.md".length);
  const parts = name.rsplit ? name.rsplit("-", 1) : splitLast(name, "-");
  if (parts.length === 2 && laneSuffixes.has(parts[1])) return parts[0];
  return name;
}

function splitLast(value, separator) {
  const index = value.lastIndexOf(separator);
  return index === -1 ? [value] : [value.slice(0, index), value.slice(index + separator.length)];
}

function repoFromWorkflow(workflowPath) {
  return path.resolve(path.dirname(workflowPath), "..");
}

function titleFromSlug(slug) {
  return slug.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function loadLinearApiKey() {
  return runtimeEnv.LINEAR_API_KEY || "";
}

function readEnvFileSync(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      values[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
    return values;
  } catch {
    return {};
  }
}

async function fetchLinearProject(linearSlugId) {
  const projectData = await linearGraphql(PROJECT_QUERY, { slugId: linearSlugId });
  const project = projectData.projects.nodes[0];
  if (!project) throw new Error(`Linear project not found for slugId ${linearSlugId}`);
  const issues = [];
  let after = null;
  do {
    const page = await linearGraphql(ISSUES_QUERY, { slugId: linearSlugId, after });
    issues.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);
  for (const issue of issues) {
    if (issue.comments.pageInfo.hasNextPage) {
      let commentAfter = issue.comments.pageInfo.endCursor;
      while (commentAfter) {
        const commentsPage = await linearGraphql(COMMENTS_QUERY, { issueId: issue.id, after: commentAfter });
        issue.comments.nodes.push(...commentsPage.issue.comments.nodes);
        commentAfter = commentsPage.issue.comments.pageInfo.hasNextPage ? commentsPage.issue.comments.pageInfo.endCursor : null;
      }
    }
  }
  return { project, issues };
}

async function linearGraphql(query, variables) {
  const response = await fetch(linearUrl, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "User-Agent": "desktop-linear-import"
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (body.errors) throw new Error(`Linear GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

function summarizeLinearProject(project, linear) {
  return {
    slug: project.slug,
    linear_slug_id: project.linear_slug_id,
    issue_count: linear.issues.length,
    comment_count: linear.issues.reduce((sum, issue) => sum + issue.comments.nodes.length, 0)
  };
}

async function importProject(project, linear) {
  const now = iso();
  const projectRow = upsertProject(project, linear.project, now);
  let issueCount = 0;
  let commentCount = 0;
  for (const linearIssue of linear.issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const issue = upsertIssue(projectRow, linearIssue, now);
    issueCount += 1;
    for (const comment of linearIssue.comments.nodes) {
      upsertComment(issue.id, comment);
      commentCount += 1;
    }
    recordEvent(issue.id, "linear_issue_imported", "Linear Import", `${issue.key} synced from Linear ${linearIssue.identifier}.`, { linear_issue_id: linearIssue.id, identifier: linearIssue.identifier }, now);
  }
  recordEvent(null, "linear_project_imported", "Linear Import", `Project ${project.slug} synced from Linear.`, { slug: project.slug, linear_slug_id: project.linear_slug_id, issue_count: issueCount, comment_count: commentCount }, now);
  return { slug: project.slug, linear_slug_id: project.linear_slug_id, issue_count: issueCount, comment_count: commentCount };
}

function upsertProject(project, linearProject, now) {
  const existing = db.prepare("SELECT * FROM projects WHERE slug = ?").get(project.slug)
    || db.prepare("SELECT * FROM projects WHERE linear_slug_id = ?").get(project.linear_slug_id);
  if (existing) {
    db.prepare("UPDATE projects SET slug = ?, name = ?, linear_slug_id = ?, source_repo = ?, workflow_path = ?, updated_at = ? WHERE id = ?").run(project.slug, project.name, project.linear_slug_id, project.source_repo, project.workflow_path, now, existing.id);
    db.prepare("UPDATE issues SET key = ? || '-' || number WHERE project_id = ?").run(project.slug, existing.id);
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(existing.id);
  }
  db.prepare("INSERT INTO projects (slug, name, next_number, created_at, updated_at, linear_slug_id, source_repo, workflow_path) VALUES (?, ?, 1, ?, ?, ?, ?, ?)").run(project.slug, project.name || linearProject.name, now, now, project.linear_slug_id, project.source_repo, project.workflow_path);
  return db.prepare("SELECT * FROM projects WHERE slug = ?").get(project.slug);
}

function upsertIssue(project, linearIssue, now) {
  const existing = db.prepare("SELECT * FROM issues WHERE linear_issue_id = ?").get(linearIssue.id);
  const labels = linearIssue.labels.nodes.map((label) => label.name);
  const importedStatus = mapLinearState(linearIssue.state?.name || "");
  const title = cleanImportedTitle(project.slug, linearIssue.title);
  const assignee = linearIssue.assignee?.name || "";
  const updatedAt = linearIssue.updatedAt || now;
  if (existing) {
    const status = existing.status || importedStatus;
    db.prepare(`
      UPDATE issues SET title = ?, description = ?, status = ?, priority = ?, labels_json = ?, assignee = ?, branch = ?, linear_identifier = ?, linear_url = ?, linear_state = ?, linear_updated_at = ?, updated_at = ? WHERE id = ?
    `).run(title, linearIssue.description || "", status, linearIssue.priorityLabel || "normal", JSON.stringify(labels), assignee, linearIssue.branchName || "", linearIssue.identifier, linearIssue.url || "", linearIssue.state?.name || "", updatedAt, updatedAt, existing.id);
    return db.prepare("SELECT * FROM issues WHERE id = ?").get(existing.id);
  }
  const currentProject = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
  const number = currentProject.next_number;
  const key = `${currentProject.slug}-${number}`;
  const status = importedStatus;
  db.prepare("UPDATE projects SET next_number = ?, updated_at = ? WHERE id = ?").run(number + 1, now, currentProject.id);
  db.prepare(`
    INSERT INTO issues (project_id, number, key, title, description, status, priority, labels_json, assignee, branch, worktree, github_url, draft_response, created_at, updated_at, linear_issue_id, linear_identifier, linear_url, linear_state, linear_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?)
  `).run(currentProject.id, number, key, title, linearIssue.description || "", status, linearIssue.priorityLabel || "normal", JSON.stringify(labels), assignee, linearIssue.branchName || "", linearIssue.createdAt || now, updatedAt, linearIssue.id, linearIssue.identifier, linearIssue.url || "", linearIssue.state?.name || "", updatedAt);
  return db.prepare("SELECT * FROM issues WHERE linear_issue_id = ?").get(linearIssue.id);
}

function cleanImportedTitle(projectSlug, title) {
  let cleaned = String(title || "").trim();
  if (projectSlug === "BC") cleaned = cleaned.replace(/^example-project-a-#\d+\s*/i, "");
  if (projectSlug === "PLS") cleaned = cleaned.replace(/^example-project-b-#\d+\s*/i, "");
  return cleaned;
}

function upsertComment(issueId, comment) {
  const now = iso();
  const existing = db.prepare("SELECT * FROM comments WHERE linear_comment_id = ?").get(comment.id);
  const author = comment.user?.name || "Linear";
  const updatedAt = comment.updatedAt || comment.createdAt || now;
  if (existing) {
    db.prepare("UPDATE comments SET author = ?, body = ?, kind = 'linear_comment', created_at = ?, updated_at = ? WHERE id = ?").run(author, comment.body || "", comment.createdAt || now, updatedAt, existing.id);
    return;
  }
  db.prepare("INSERT INTO comments (issue_id, author, body, kind, created_at, linear_comment_id, updated_at) VALUES (?, ?, ?, 'linear_comment', ?, ?, ?)").run(issueId, author, comment.body || "", comment.createdAt || now, comment.id, updatedAt);
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

function recordEvent(issueId, type, actor, summary, payload = {}, now = iso()) {
  db.prepare("INSERT INTO events (issue_id, type, actor, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(issueId, type, actor, summary, JSON.stringify(payload), now);
  appendFile(eventsPath, `${JSON.stringify({ issue_id: issueId, type, actor, summary, payload, created_at: now })}\n`, "utf8").catch(() => {});
}

function mapLinearState(name) {
  const normalized = String(name).trim().toLowerCase();
  if (normalized === "backlog") return "backlog";
  if (["todo", "to do"].includes(normalized)) return "todo";
  if (normalized === "in progress") return "in_progress";
  if (normalized === "rework") return "rework";
  if (normalized === "code review" || normalized === "in review") return "code_review";
  if (normalized === "human review" || normalized === "ready for human review") return "human_review";
  if (normalized === "merging") return "merging";
  if (["done", "closed", "complete", "completed"].includes(normalized)) return "done";
  if (["cancelled", "canceled", "duplicate"].includes(normalized)) return "canceled";
  return "todo";
}

function normalizeSlug(value) {
  return String(value || "PROJECT").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "PROJECT";
}

function iso() {
  return new Date().toISOString();
}

const PROJECT_QUERY = `
query DesktopLinearProject($slugId: String!) {
  projects(first: 1, filter: { slugId: { eq: $slugId } }) {
    nodes { id name slugId }
  }
}`;

const ISSUES_QUERY = `
query DesktopLinearIssues($slugId: String!, $after: String) {
  issues(first: 50, after: $after, filter: { project: { slugId: { eq: $slugId } } }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      number
      title
      url
      description
      priorityLabel
      branchName
      createdAt
      updatedAt
      assignee { name }
      labels { nodes { name } }
      state { name type }
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt updatedAt user { name } }
      }
    }
  }
}`;

const COMMENTS_QUERY = `
query DesktopLinearComments($issueId: String!, $after: String) {
  issue(id: $issueId) {
    comments(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id body createdAt updatedAt user { name } }
    }
  }
}`;

await main();
