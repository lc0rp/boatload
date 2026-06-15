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
assert(appJs.includes("startIssueFieldEdit"), "expected issue detail fields to enter inline edit mode");
assert(appJs.includes("saveIssueField"), "expected issue detail inline edits to persist through the patch endpoint");
assert(appJs.includes('card.status !== "done"'), "expected Done issues to suppress inline detail editing");
assert(appJs.includes('actor: "User"'), "expected inline edits to identify the editor in history");
assert(stylesCss.includes(".stat.active"), "expected active status counter styling");
assert(stylesCss.includes(".stat:hover"), "expected status counters to have hover affordance");
assert(!stylesCss.includes(".segmented button.active"), "expected old segmented-tab active styling to be removed");
assert(stylesCss.includes(".editable-field"), "expected editable issue fields to have a hover/focus affordance");
assert(stylesCss.includes(".inline-editor"), "expected inline issue editors to share stable styling");

console.log("UI validation passed: status counters and issue detail inline editing are wired.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
