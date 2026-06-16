import { findProject, parseProjectCandidate, projectCreateLabel, projectDisplayName } from "./project-selector.js";
import { HISTORY_PAGE_SIZE, clampHistoryPage, historyPageItems, latestHistoryPage, mergedHistoryItems } from "./history.js";

let model = null;
let activeCardId = null;
let filter = "open";
let lastFlowDirection = 1;
let mobileView = "list";
let activeProjectSlug = projectFromLocation() || localStorage.getItem("desktop-linear.activeProject") || "";
let historySortDirection = "asc";
let issueSearchQuery = "";
const historyPages = new Map();
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
const sortToggle = document.querySelector("#sortToggle");
const statusSelect = document.querySelector("#statusSelect");
const projectSelect = document.querySelector("#projectSelect");
const projectOptions = document.querySelector("#projectOptions");
const issueSearch = document.querySelector("#issueSearch");
const issueDialog = document.querySelector("#issueDialog");
const issueForm = document.querySelector("#issueForm");

document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#addIssue").addEventListener("click", openIssueDialog);
sortToggle.addEventListener("click", toggleSortDirection);
statusSelect.addEventListener("change", () => {
  filter = statusSelect.value;
  mobileView = "list";
  activeCardId = visibleCards()[0]?.id || null;
  updateFilterButtons();
  render();
});
issueForm.addEventListener("submit", createIssue);
issueForm.querySelectorAll("button[value='cancel']").forEach((button) => button.addEventListener("click", () => issueDialog.close()));
projectSelect.addEventListener("input", renderProjectOptions);
projectSelect.addEventListener("focus", renderProjectOptions);
projectSelect.addEventListener("keydown", handleProjectKeydown);
projectOptions.addEventListener("click", handleProjectOptionClick);
issueSearch.addEventListener("input", () => {
  issueSearchQuery = issueSearch.value;
  render();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".project-combobox")) hideProjectOptions();
});
stats.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  updateFilterButtons();
  render();
});
document.addEventListener("keydown", handleGlobalShortcut);

async function load() {
  const project = activeProjectSlug || projectSelect.value || "";
  const response = await fetch(`/api/model${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  model = await response.json();
  activeProjectSlug = model.app.active_project_slug || model.projects[0]?.slug || activeProjectSlug;
  renderProjectSelect();
  renderSortToggle();
  persistActiveProject(model.app.active_project_slug);
  activeCardId = activeCardId || model.cards[0]?.id || null;
  render();
}

function renderProjectSelect() {
  const current = model.projects.find((project) => project.slug === activeProjectSlug) || model.projects[0] || null;
  activeProjectSlug = current?.slug || activeProjectSlug;
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
  mobileView = "list";
  hideProjectOptions();
  await persistActiveProject(activeProjectSlug);
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
    mobileView = "list";
    hideProjectOptions();
    await persistActiveProject(activeProjectSlug);
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
  await persistActiveProject(activeProjectSlug);
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
  const cards = filter === "all"
    ? model.cards
    : filter === "open"
      ? model.cards.filter((card) => openStates.has(card.status))
      : model.cards.filter((card) => card.status === filter);
  return cards.filter((card) => issueMatchesSearch(card, issueSearchQuery));
}

function issueMatchesSearch(card, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [card.key, card.title, card.description]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function render() {
  renderStats();
  renderStatusSelect();
  renderSortToggle();
  const cards = visibleCards();
  if (!cards.length) mobileView = "list";
  if (document.body) document.body.dataset.mobileView = mobileView;
  if (!cards.find((card) => card.id === activeCardId)) activeCardId = cards[0]?.id || null;
  rail.innerHTML = cards.map(cardButton).join("");
  for (const button of rail.querySelectorAll(".card")) {
    button.addEventListener("click", () => {
      activeCardId = button.dataset.id;
      mobileView = "detail";
      render();
      scrollToTop();
    });
  }
  const active = cards.find((card) => card.id === activeCardId);
  detail.innerHTML = active ? detailView(active) : `<div class="empty">${escapeHtml(emptyMessage())}</div>`;
  wireDetail(active);
  rail.querySelector(".card.active")?.scrollIntoView({ block: "nearest" });
}

function emptyMessage() {
  return issueSearchQuery.trim() ? "No issues match this search." : "No issues in this view.";
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
  const data = statusFilterOptions();
  stats.innerHTML = data.map(([key, label, value]) => `
    <button type="button" class="stat ${key === filter ? "active" : ""}" data-filter="${escapeAttr(key)}" aria-pressed="${key === filter}">
      <strong>${value}</strong><span>${label}</span>
    </button>
  `).join("");
}

function renderStatusSelect() {
  statusSelect.innerHTML = statusFilterOptions().map(([key, label, value]) => `
    <option value="${escapeAttr(key)}">${escapeHtml(label)} (${value})</option>
  `).join("");
  statusSelect.value = filter;
}

function statusFilterOptions() {
  return [
    ["open", "Open", model.stats.open],
    ["backlog", "Backlog", model.stats.backlog],
    ["todo", "Todo", model.stats.todo],
    ["in_progress", "In Progress", model.stats.in_progress],
    ["rework", "Rework", model.stats.rework],
    ["code_review", "Code Review", model.stats.code_review],
    ["human_review", "Human Review", model.stats.human_review],
    ["merging", "Merging", model.stats.merging],
    ["done", "Done", model.stats.done],
    ["all", "Total", model.stats.total]
  ];
}

function cardButton(card) {
  return `
    <button class="card ${card.id === activeCardId ? "active" : ""}" data-id="${escapeAttr(card.id)}">
      <div class="tags">${tagHtml([card.status, ...card.labels])}</div>
      <h2><span class="key">${escapeHtml(card.key)}</span> ${escapeHtml(card.title)}</h2>
      <div class="meta">${escapeHtml(developer-machine.local_time)}<span class="card-status-meta"> · ${escapeHtml(card.status_label)}</span> · ${escapeHtml(card.priority)}</div>
      ${cardSummaryHtml(card)}
    </button>
  `;
}

function detailView(card) {
  return `
    ${mobileDetailNav(card)}
    <div class="detail-header">
      <div>
        <div class="tags detail-tags">${tagHtml([card.status, ...card.labels])}</div>
        <div class="source">${escapeHtml(card.project_name)} · ${escapeHtml(card.key)} · Updated ${escapeHtml(developer-machine.local_time)}</div>
        <h2>${escapeHtml(card.title)}</h2>
        <div class="source detail-branch">${escapeHtml(card.branch || "No branch")} ${card.worktree ? `· ${escapeHtml(card.worktree)}` : ""}</div>
      </div>
      <span class="pill">${escapeHtml(card.status_label)}</span>
    </div>

    <div class="section">
      <h3>Issue Context</h3>
      <div class="issue-context">${escapeHtml(card.description || "No description yet.")}</div>
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
      <h3>Talk To This Issue</h3>
      <div class="talk-box">
        <input id="talk" placeholder="Ask Codex, add a note, or say move to Code Review">
        <button id="sendTalk">Send</button>
      </div>
    </div>

    <div class="section">
      <h3>History Comment</h3>
      <div class="comment-box">
        <textarea id="comment" placeholder="Record a Desktop Symphony update, blocker, or decision in history"></textarea>
        <button id="sendComment">Add Comment</button>
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
      <div class="section-header">
        <h3>History</h3>
        <button id="historySortToggle" class="sort-toggle history-sort-toggle" type="button" data-direction="${escapeAttr(historySortDirection)}" title="${historySortDirection === "asc" ? "Oldest first" : "Newest first"}" aria-label="${historySortDirection === "asc" ? "Sort history, oldest first" : "Sort history, newest first"}">
          ${sortIconSvg()}
        </button>
      </div>
      <div class="history">${historyHtml(card)}</div>
    </div>
  `;
}

function cardSummaryHtml(card) {
  const summary = String(card.summary || "").trim();
  if (!summary || summary.toLowerCase() === "no description yet.") return "";
  return `<div class="card-summary">${escapeHtml(truncateText(summary, 140))}</div>`;
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function mobileDetailNav(card) {
  const cards = visibleCards();
  const index = cards.findIndex((candidate) => candidate.id === card.id);
  const previousDisabled = index <= 0 ? "disabled" : "";
  const nextDisabled = index < 0 || index >= cards.length - 1 ? "disabled" : "";
  return `
    <nav class="mobile-detail-nav" aria-label="Issue navigation">
      <button type="button" data-mobile-nav="prev" ${previousDisabled}>&lt; Prev</button>
      <button type="button" data-mobile-nav="list">List</button>
      <button type="button" data-mobile-nav="next" ${nextDisabled}>Next &gt;</button>
    </nav>
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
  for (const button of detail.querySelectorAll("[data-mobile-nav]")) {
    button.addEventListener("click", () => handleMobileNavigation(button.dataset.mobileNav));
  }
  for (const button of detail.querySelectorAll("button[data-status]")) {
    button.addEventListener("click", () => postStatus(card.id, button.dataset.status));
  }
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
  document.querySelector("#historySortToggle")?.addEventListener("click", () => {
    historySortDirection = historySortDirection === "asc" ? "desc" : "asc";
    historyPages.delete(card.id);
    render();
  });
  for (const button of detail.querySelectorAll("button[data-history-page]")) {
    button.addEventListener("click", () => {
      historyPages.set(card.id, Number.parseInt(button.dataset.historyPage, 10));
      render();
    });
  }
}

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  model = await response.json();
  if (model.model) model = model.model;
  renderProjectSelect();
  persistActiveProject(model.app.active_project_slug);
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
  if (!activeCardId) mobileView = "list";
  render();
}

function openIssueDialog() {
  issueForm.reset();
  issueDialog.showModal();
  issueForm.elements.issue.focus();
}

async function createIssue(event) {
  event.preventDefault();
  const data = new FormData(issueForm);
  const issueText = String(data.get("issue") || "");
  const issue = deriveIssueFields(issueText);
  const response = await fetch("/api/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_slug: selectedProjectSlug(),
      title: issue.title,
      description: issue.description
    })
  });
  const payload = await response.json();
  model = payload.model;
  activeProjectSlug = model.app.active_project_slug || activeProjectSlug;
  activeCardId = String(payload.issue.issue_id);
  mobileView = "detail";
  issueDialog.close();
  renderProjectSelect();
  render();
}

function deriveIssueFields(input) {
  const description = input.replace(/\r\n?/g, "\n").trim();
  const firstLine = description.split("\n").map((line) => line.trim()).find(Boolean) || "Untitled issue";
  const title = firstLine.length > 110 ? `${firstLine.slice(0, 107).trimEnd()}...` : firstLine;
  return { title, description };
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

function handleMobileNavigation(action) {
  if (action === "list") {
    mobileView = "list";
    render();
    scrollToTop();
    return;
  }
  const cards = visibleCards();
  const index = cards.findIndex((card) => card.id === activeCardId);
  const delta = action === "next" ? 1 : -1;
  const next = cards[index + delta];
  if (!next) return;
  activeCardId = next.id;
  mobileView = "detail";
  render();
  scrollToTop();
}

function scrollToTop() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function selectAfterRemoval(cardId, previousIndex) {
  const cards = visibleCards();
  if (!cards.length) return activeCardId = null;
  if (cards.some((card) => card.id === cardId)) return activeCardId = cardId;
  const targetIndex = lastFlowDirection >= 0 ? previousIndex : previousIndex - 1;
  activeCardId = cards[Math.min(cards.length - 1, Math.max(0, targetIndex))].id;
}

function updateFilterButtons() {
  for (const node of stats.querySelectorAll("button[data-filter]")) {
    const isActive = node.dataset.filter === filter;
    node.classList.toggle("active", isActive);
    node.setAttribute("aria-pressed", String(isActive));
  }
}

function projectFromLocation() {
  return new URLSearchParams(window.location.search).get("project") || "";
}

async function persistActiveProject(projectSlug) {
  if (!projectSlug) return;
  activeProjectSlug = projectSlug;
  localStorage.setItem("desktop-linear.activeProject", projectSlug);
  const url = new URL(window.location.href);
  if (url.searchParams.get("project") !== projectSlug) {
    url.searchParams.set("project", projectSlug);
    window.history.replaceState({}, "", url);
  }
  await postRaw("/api/settings", { active_project_slug: projectSlug });
}

function tagHtml(tags) {
  return tags.filter(Boolean).map((tag) => `<span class="tag ${escapeAttr(String(tag).toLowerCase())}">${escapeHtml(label(String(tag)))}</span>`).join("");
}
function historyHtml(card) {
  const direction = historySortDirection === "asc" ? 1 : -1;
  const all = mergedHistoryItems(card).sort((a, b) => direction * (new Date(a.at) - new Date(b.at)));
  if (!all.length) return `<p class="meta">No steps recorded yet.</p>`;
  const page = clampHistoryPage(historyPages.get(card.id) || latestHistoryPage(all.length), all.length);
  historyPages.set(card.id, page);
  const items = historyPageItems(all, page);
  const controls = all.length > HISTORY_PAGE_SIZE ? historyPaginationHtml(page, latestHistoryPage(all.length), all.length) : "";
  return `${items.map(historyItemHtml).join("")}${controls}`;
}
function historyItemHtml(item) {
  return `<div class="history-item"><div class="history-line">${escapeHtml(item.speaker)} · ${escapeHtml(formatTime(item.at))}</div><div class="history-text">${linkHistoryText(item.text)}</div></div>`;
}
function historyPaginationHtml(page, pageCount, totalItems) {
  const from = ((page - 1) * HISTORY_PAGE_SIZE) + 1;
  const to = Math.min(totalItems, page * HISTORY_PAGE_SIZE);
  const older = page > 1 ? `<button type="button" data-history-page="${page - 1}">Older</button>` : `<button type="button" disabled>Older</button>`;
  const newer = page < pageCount ? `<button type="button" data-history-page="${page + 1}">Newer</button>` : `<button type="button" disabled>Newer</button>`;
  return `
    <div class="history-pagination" aria-label="History pagination">
      ${older}
      <span>Items ${from}-${to} of ${totalItems}</span>
      ${newer}
    </div>
  `;
}
function linkHistoryText(value) {
  const text = String(value ?? "");
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+/g;
  let html = "";
  let lastIndex = 0;
  for (const match of text.matchAll(urlPattern)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
    const trailing = rawUrl.match(/[.,;:!?)]*$/)?.[0] || "";
    const url = rawUrl.slice(0, rawUrl.length - trailing.length);
    if (!url) continue;
    html += escapeHtml(text.slice(lastIndex, start));
    html += `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`;
    html += escapeHtml(trailing);
    lastIndex = start + rawUrl.length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}
function sortIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4v15M6 19l-3-3M6 19l3-3"></path>
      <path d="M12 6h9M12 10h7M12 14h5M12 18h3"></path>
    </svg>
  `;
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

if (globalThis.__DESKTOP_LINEAR_TESTS__) {
  globalThis.__DESKTOP_LINEAR_TESTS__.historyHtml = historyHtml;
  globalThis.__DESKTOP_LINEAR_TESTS__.linkHistoryText = linkHistoryText;
  globalThis.__DESKTOP_LINEAR_TESTS__.issueMatchesSearch = issueMatchesSearch;
}

load();
