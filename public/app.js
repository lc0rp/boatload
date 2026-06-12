import { findProject, parseProjectCandidate, projectCreateLabel, projectDisplayName } from "./project-selector.js";

let model = null;
let activeCardId = null;
let filter = "open";
let lastFlowDirection = 1;
let activeProjectSlug = "";
const openStates = new Set(["backlog", "todo", "in_progress", "rework", "code_review", "human_review", "merging"]);
const lifecycleStates = [
  ["backlog", "Backlog", "B"],
  ["todo", "Todo", "T"],
  ["in_progress", "Progress", "I"],
  ["rework", "Rework", "W"],
  ["code_review", "Code Review", "C"],
  ["human_review", "Human Review", "H"],
  ["merging", "Merging", "M"],
  ["done", "Done", "D", "primary"]
];

const rail = document.querySelector("#rail");
const detail = document.querySelector("#detail");
const stats = document.querySelector("#stats");
const filters = document.querySelector("#filters");
const sortToggle = document.querySelector("#sortToggle");
const projectSelect = document.querySelector("#projectSelect");
const projectOptions = document.querySelector("#projectOptions");
const issueDialog = document.querySelector("#issueDialog");
const issueForm = document.querySelector("#issueForm");

document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#addIssue").addEventListener("click", openIssueDialog);
sortToggle.addEventListener("click", toggleSortDirection);
issueForm.addEventListener("submit", createIssue);
issueForm.querySelectorAll("button[value='cancel']").forEach((button) => button.addEventListener("click", () => issueDialog.close()));
projectSelect.addEventListener("input", renderProjectOptions);
projectSelect.addEventListener("focus", renderProjectOptions);
projectSelect.addEventListener("keydown", handleProjectKeydown);
projectOptions.addEventListener("click", handleProjectOptionClick);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".project-combobox")) hideProjectOptions();
});
filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  updateFilterButtons();
  render();
});
document.addEventListener("keydown", handleGlobalShortcut);

async function load() {
  const project = activeProjectSlug || "";
  const response = await fetch(`/api/model${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  model = await response.json();
  activeProjectSlug = model.app.active_project_slug || model.projects[0]?.slug || activeProjectSlug;
  renderProjectSelect();
  renderSortToggle();
  activeCardId = activeCardId || model.cards[0]?.id || null;
  render();
}

function renderProjectSelect() {
  const current = model.projects.find((project) => project.slug === activeProjectSlug) || model.projects[0] || null;
  projectSelect.value = projectDisplayName(current);
  hideProjectOptions();
}

function renderProjectOptions() {
  if (!model) return;
  const query = projectSelect.value.trim();
  const lowerQuery = query.toLowerCase();
  const matches = model.projects.filter((project) => {
    if (!lowerQuery) return true;
    return project.slug.toLowerCase().includes(lowerQuery) || project.name.toLowerCase().includes(lowerQuery) || projectDisplayName(project).toLowerCase().includes(lowerQuery);
  });
  const exact = findProject(model.projects, query);
  const candidate = parseProjectCandidate(query);
  const canCreate = candidate && !model.projects.some((project) => project.slug === candidate.stub) && !exact;
  const existingHtml = matches.map((project) => `
    <button type="button" role="option" data-project-slug="${escapeAttr(project.slug)}">
      ${escapeHtml(projectDisplayName(project))}
    </button>
  `).join("");
  const createHtml = canCreate ? `
    <button type="button" role="option" data-create-project="true">
      ${escapeHtml(projectCreateLabel(candidate))}
    </button>
  ` : "";
  projectOptions.innerHTML = `${existingHtml}${createHtml}`;
  const hasOptions = Boolean(matches.length || canCreate);
  projectOptions.hidden = !hasOptions;
  projectSelect.setAttribute("aria-expanded", String(hasOptions));
}

async function handleProjectOptionClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.createProject) return createProjectFromSelector();
  if (!button.dataset.projectSlug) return;
  activeProjectSlug = button.dataset.projectSlug;
  activeCardId = null;
  hideProjectOptions();
  await load();
}

async function handleProjectKeydown(event) {
  if (event.key === "Escape") return hideProjectOptions();
  if (event.key !== "Enter") return;
  const exact = findProject(model?.projects || [], projectSelect.value);
  if (exact) {
    event.preventDefault();
    activeProjectSlug = exact.slug;
    activeCardId = null;
    hideProjectOptions();
    return load();
  }
  const candidate = parseProjectCandidate(projectSelect.value);
  if (candidate) {
    event.preventDefault();
    return createProjectFromSelector();
  }
}

async function createProjectFromSelector() {
  const candidate = parseProjectCandidate(projectSelect.value);
  if (!candidate) return;
  model = await postRaw("/api/projects", { slug: candidate.stub, name: candidate.name });
  activeProjectSlug = candidate.stub;
  activeCardId = model.cards[0]?.id || null;
  renderProjectSelect();
  render();
}

function hideProjectOptions() {
  projectOptions.hidden = true;
  projectSelect.setAttribute("aria-expanded", "false");
}

function selectedProjectSlug() {
  return activeProjectSlug || model?.app?.active_project_slug || model?.projects[0]?.slug || "DL";
}

function visibleCards() {
  if (!model) return [];
  if (filter === "all") return model.cards;
  if (filter === "open") return model.cards.filter((card) => openStates.has(card.status));
  return model.cards.filter((card) => card.status === filter);
}

function render() {
  renderStats();
  renderSortToggle();
  const cards = visibleCards();
  if (!cards.find((card) => card.id === activeCardId)) activeCardId = cards[0]?.id || null;
  rail.innerHTML = cards.map(cardButton).join("");
  for (const button of rail.querySelectorAll(".card")) {
    button.addEventListener("click", () => {
      activeCardId = button.dataset.id;
      render();
    });
  }
  const active = cards.find((card) => card.id === activeCardId);
  detail.innerHTML = active ? detailView(active) : `<div class="empty">No issues in this view.</div>`;
  wireDetail(active);
  rail.querySelector(".card.active")?.scrollIntoView({ block: "nearest" });
}

function renderSortToggle() {
  const direction = model?.app?.sort_direction === "asc" ? "asc" : "desc";
  sortToggle.dataset.direction = direction;
  sortToggle.title = direction === "asc" ? "Oldest first" : "Newest first";
  sortToggle.setAttribute("aria-label", direction === "asc" ? "Sort by date, oldest first" : "Sort by date, newest first");
}

async function toggleSortDirection() {
  const current = model?.app?.sort_direction === "asc" ? "asc" : "desc";
  const next = current === "asc" ? "desc" : "asc";
  model = await postRaw("/api/settings", {
    sort_direction: next,
    project_slug: selectedProjectSlug()
  });
  activeCardId = model.cards[0]?.id || activeCardId;
  renderProjectSelect();
  render();
}

function renderStats() {
  const data = [["Open", model.stats.open], ["Backlog", model.stats.backlog], ["Todo", model.stats.todo], ["Progress", model.stats.in_progress], ["Rework", model.stats.rework], ["Review", model.stats.code_review], ["Human", model.stats.human_review], ["Merging", model.stats.merging], ["Done", model.stats.done], ["Total", model.stats.total]];
  stats.innerHTML = data.map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function cardButton(card) {
  return `
    <button class="card ${card.id === activeCardId ? "active" : ""}" data-id="${escapeAttr(card.id)}">
      <div class="tags">${tagHtml([card.status, ...card.labels])}</div>
      <h2><span class="key">${escapeHtml(card.key)}</span> ${escapeHtml(card.title)}</h2>
      <div class="meta">${escapeHtml(developer-machine.local_time)} · ${escapeHtml(card.status_label)} · ${escapeHtml(card.priority)}</div>
      <div class="card-summary">${escapeHtml(card.summary)}</div>
    </button>
  `;
}

function detailView(card) {
  return `
    <div class="detail-header">
      <div>
        <div class="tags">${tagHtml([card.status, ...card.labels])}</div>
        <div class="source">${escapeHtml(card.project_name)} · ${escapeHtml(card.key)} · Updated ${escapeHtml(developer-machine.local_time)}</div>
        <h2>${escapeHtml(card.title)}</h2>
        <div class="source">${escapeHtml(card.branch || "No branch")} ${card.worktree ? `· ${escapeHtml(card.worktree)}` : ""}</div>
      </div>
      <span class="pill">${escapeHtml(card.status_label)}</span>
    </div>

    <div class="section">
      <h3>Issue Context</h3>
      <p>${escapeHtml(card.description || "No description yet.")}</p>
    </div>

    <div class="section action-panel">
      <h3>Proposed Action</h3>
      <p><strong>${escapeHtml(card.proposed_action.label)}</strong>: ${escapeHtml(card.proposed_action.prompt)}</p>
    </div>

    <div class="section">
      <h3>Desktop Symphony Lifecycle</h3>
      <div class="action-row">
        ${lifecycleStates.map(([status, label, key, className]) => stateButton(status, label, key, className || "", card.status)).join("")}
      </div>
    </div>

    <div class="section">
      <h3>Draft Response Or Workpad Note</h3>
      <textarea class="draft" id="draft">${escapeHtml(card.draft_response || card.proposed_action.draft || "")}</textarea>
    </div>

    <div class="section">
      <h3>Talk To This Issue</h3>
      <div class="talk-box">
        <input id="talk" placeholder="Ask Codex, add a note, or say move to Code Review">
        <button id="sendTalk">Send</button>
      </div>
    </div>

    <div class="section">
      <h3>Add Comment</h3>
      <div class="comment-box">
        <textarea id="comment" placeholder="Record a Desktop Symphony workpad update, blocker, or decision"></textarea>
        <button id="sendComment">Add</button>
      </div>
    </div>

    <div class="section">
      <h3>Links</h3>
      <p>
        ${card.linear_url ? `Linear: <a href="${escapeAttr(card.linear_url)}" target="_blank" rel="noreferrer">${escapeHtml(card.linear_identifier || card.linear_url)}</a><br>` : ""}
        ${card.github_url ? `GitHub: <a href="${escapeAttr(card.github_url)}" target="_blank" rel="noreferrer">${escapeHtml(card.github_url)}</a>` : "No GitHub URL recorded."}
      </p>
    </div>

    <div class="section">
      <h3>History</h3>
      <div class="history">${historyHtml(card)}</div>
    </div>
  `;
}

function stateButton(status, label, key, className = "", currentStatus = "") {
  const isCurrent = status === currentStatus;
  const classes = [className, isCurrent ? "current-status" : ""].filter(Boolean).join(" ");
  const attrs = isCurrent ? `disabled aria-current="true"` : `data-status="${status}" title="Shortcut: ${key}"`;
  return `<button class="${classes}" ${attrs}>${label} <span class="shortcut">${key}</span></button>`;
}

function wireDetail(card) {
  if (!card) return;
  for (const button of detail.querySelectorAll("button[data-status]")) {
    button.addEventListener("click", () => postStatus(card.id, button.dataset.status));
  }
  const draft = document.querySelector("#draft");
  draft.addEventListener("change", async () => {
    await post(`/api/issues/${encodeURIComponent(card.id)}/patch`, { draft_response: draft.value, project_slug: selectedProjectSlug() });
  });
  const talk = document.querySelector("#talk");
  const sendTalk = async () => {
    if (!talk.value.trim()) return;
    await post(`/api/issues/${encodeURIComponent(card.id)}/talk`, { text: talk.value, project_slug: selectedProjectSlug() });
    talk.value = "";
  };
  document.querySelector("#sendTalk").addEventListener("click", sendTalk);
  talk.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendTalk();
  });
  const comment = document.querySelector("#comment");
  document.querySelector("#sendComment").addEventListener("click", async () => {
    if (!comment.value.trim()) return;
    await post(`/api/issues/${encodeURIComponent(card.id)}/comment`, { body: comment.value, project_slug: selectedProjectSlug() });
    comment.value = "";
  });
}

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  model = await response.json();
  if (model.model) model = model.model;
  renderProjectSelect();
  render();
}

async function postRaw(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

async function postStatus(cardId, status) {
  const previousCards = visibleCards();
  const previousIndex = previousCards.findIndex((card) => card.id === cardId);
  await post(`/api/issues/${encodeURIComponent(cardId)}/status`, { status, project_slug: selectedProjectSlug() });
  selectAfterRemoval(cardId, previousIndex);
  render();
}

function openIssueDialog() {
  issueForm.reset();
  issueDialog.showModal();
  issueForm.elements.title.focus();
}

async function createIssue(event) {
  event.preventDefault();
  const data = new FormData(issueForm);
  const response = await fetch("/api/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_slug: selectedProjectSlug(),
      title: data.get("title"),
      description: data.get("description")
    })
  });
  const payload = await response.json();
  model = payload.model;
  activeProjectSlug = model.app.active_project_slug || activeProjectSlug;
  activeCardId = String(payload.issue.issue_id);
  issueDialog.close();
  renderProjectSelect();
  render();
}

async function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !detail.contains(document.activeElement)) {
    event.preventDefault();
    moveActiveCard(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "+" || event.key === "=") return openIssueDialog();
  if (key === "r") return load();
  const card = model?.cards.find((candidate) => candidate.id === activeCardId);
  if (!card) return;
  const map = { b: "backlog", t: "todo", i: "in_progress", w: "rework", c: "code_review", h: "human_review", m: "merging", d: "done" };
  if (map[key]) {
    if (card.status === map[key]) return;
    event.preventDefault();
    await postStatus(card.id, map[key]);
  }
}

function moveActiveCard(delta) {
  const cards = visibleCards();
  if (!cards.length) return;
  lastFlowDirection = delta > 0 ? 1 : -1;
  const currentIndex = Math.max(0, cards.findIndex((card) => card.id === activeCardId));
  const nextIndex = Math.min(cards.length - 1, Math.max(0, currentIndex + delta));
  if (nextIndex !== currentIndex) {
    activeCardId = cards[nextIndex].id;
    render();
  }
}

function selectAfterRemoval(cardId, previousIndex) {
  const cards = visibleCards();
  if (!cards.length) return activeCardId = null;
  if (cards.some((card) => card.id === cardId)) return activeCardId = cardId;
  const targetIndex = lastFlowDirection >= 0 ? previousIndex : previousIndex - 1;
  activeCardId = cards[Math.min(cards.length - 1, Math.max(0, targetIndex))].id;
}

function updateFilterButtons() {
  for (const node of filters.querySelectorAll("button")) node.classList.toggle("active", node.dataset.filter === filter);
}

function tagHtml(tags) {
  return tags.filter(Boolean).map((tag) => `<span class="tag ${escapeAttr(String(tag).toLowerCase())}">${escapeHtml(label(String(tag)))}</span>`).join("");
}
function historyHtml(card) {
  const events = card.events.map((event) => ({ at: event.created_at, speaker: event.actor, text: event.summary }));
  const comments = card.comments.map((comment) => ({ at: comment.created_at, speaker: comment.author, text: comment.body }));
  const all = [...events, ...comments].sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!all.length) return `<p class="meta">No steps recorded yet.</p>`;
  return all.map((item) => `<div class="history-item"><div class="history-line">${escapeHtml(item.speaker)} · ${escapeHtml(formatTime(item.at))}</div><div class="history-text">${escapeHtml(item.text)}</div></div>`).join("");
}
function formatTime(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function label(value) {
  if (value.includes(":")) return value;
  return value.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
function isTypingTarget(target) {
  const element = target instanceof Element ? target : null;
  return element && ["input", "textarea", "select"].includes(element.tagName.toLowerCase());
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function escapeAttr(value) {
  return escapeHtml(value);
}

load();
