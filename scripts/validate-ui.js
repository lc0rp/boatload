import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

assert(indexHtml.includes('id="stats"'), "expected the status counter strip to exist");
assert(!indexHtml.includes('id="filters"'), "expected old status tab strip to be removed");
assert(!indexHtml.includes('class="segmented"'), "expected segmented status tabs to be removed");
assert(appJs.includes('stats.addEventListener("click"'), "expected status counters to handle filter clicks");
assert(!appJs.includes('querySelector("#filters")'), "expected app JS not to bind old status tabs");
assert(!appJs.includes("filters.addEventListener"), "expected old filter click handler to be removed");
assert(appJs.includes("[\"all\", \"Total\""), "expected Total counter to map to the all filter");
assert(/<button[^>]+class="stat/.test(appJs), "expected stats renderer to output clickable stat buttons");
assert(appJs.includes("data-filter="), "expected stat buttons to expose data-filter attributes");
assert(appJs.includes("aria-pressed"), "expected stat buttons to expose pressed state");
assert(stylesCss.includes(".stat.active"), "expected active status counter styling");
assert(stylesCss.includes(".stat:hover"), "expected status counters to have hover affordance");
assert(!stylesCss.includes(".segmented button.active"), "expected old segmented-tab active styling to be removed");
assert(indexHtml.includes('id="issueSearch"'), "expected issue search input next to project selector");
assert(indexHtml.includes('aria-label="Search issues by ID, title, or description"'), "expected issue search to describe searchable fields");
assert(appJs.includes("issueMatchesSearch"), "expected issue filtering helper");
assert(appJs.includes("card.key, card.title, card.description"), "expected issue search to include ID, title, and description");
assert(appJs.includes('issueSearch.addEventListener("input"'), "expected issue search input to update rendered cards");
assert(stylesCss.includes(".issue-search"), "expected issue search styling");

console.log("UI validation passed: status counters filter state and issue search filters by ID, title, and description.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
