import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

assert(indexHtml.includes('id="stats"'), "expected the status counter strip to exist");
assert(indexHtml.includes('id="statusSelect"'), "expected mobile status selector to exist");
assert(!indexHtml.includes('id="filters"'), "expected old status tab strip to be removed");
assert(!indexHtml.includes('class="segmented"'), "expected segmented status tabs to be removed");
assert(appJs.includes('stats.addEventListener("click"'), "expected status counters to handle filter clicks");
assert(appJs.includes('statusSelect.addEventListener("change"'), "expected mobile status selector to change the list filter");
assert(appJs.includes('function renderStatusSelect()'), "expected status selector labels to render from current counts");
assert(appJs.includes('function mobileDetailNav(card)'), "expected mobile detail navigation renderer");
assert(appJs.includes('data-mobile-nav="list"'), "expected detail view to expose a list return control");
assert(appJs.includes('body.dataset.mobileView'), "expected mobile list/detail view state on the document body");
assert(appJs.includes('function cardSummaryHtml(card)'), "expected compact card summary rendering");
assert(!appJs.includes('querySelector("#filters")'), "expected app JS not to bind old status tabs");
assert(!appJs.includes("filters.addEventListener"), "expected old filter click handler to be removed");
assert(appJs.includes("[\"all\", \"Total\""), "expected Total counter to map to the all filter");
assert(/<button[^>]+class="stat/.test(appJs), "expected stats renderer to output clickable stat buttons");
assert(appJs.includes("data-filter="), "expected stat buttons to expose data-filter attributes");
assert(appJs.includes("aria-pressed"), "expected stat buttons to expose pressed state");
assert(stylesCss.includes(".stat.active"), "expected active status counter styling");
assert(stylesCss.includes(".stat:hover"), "expected status counters to have hover affordance");
assert(!stylesCss.includes(".segmented button.active"), "expected old segmented-tab active styling to be removed");
assert(stylesCss.includes("overflow-wrap: anywhere"), "expected long mobile text to wrap instead of forcing horizontal scroll");
assert(stylesCss.includes("grid-template-columns: 1fr"), "expected mobile layout to collapse to one column");
assert(stylesCss.includes(".talk-box, .comment-box { grid-template-columns: 1fr; }"), "expected mobile input actions to stack vertically");
assert(stylesCss.includes("max-height: none") && stylesCss.includes("overflow: visible") && stylesCss.includes("width: 100%"), "expected mobile panes to stay within viewport width");
assert(stylesCss.includes(".topbar { display: none; }"), "expected mobile view to remove explainer and title from first action path");
assert(stylesCss.includes(".status-select { display: block; }"), "expected mobile status selector to be visible");
assert(stylesCss.includes('body[data-mobile-view="list"] .detail { display: none; }'), "expected mobile list view to hide detail");
assert(stylesCss.includes('body[data-mobile-view="detail"] .toolbar { display: none; }'), "expected mobile detail view to put pager first");
assert(stylesCss.includes('body[data-mobile-view="detail"] .rail { display: none; }'), "expected mobile detail view to hide list");
assert(stylesCss.includes(".detail-header .tags"), "expected mobile detail to hide repeated status tags");
assert(stylesCss.includes(".card-status-meta { display: none; }"), "expected mobile cards not to repeat the selected status");
assert(stylesCss.includes("-webkit-line-clamp: 2"), "expected mobile card summaries to be tightly clamped");

console.log("UI validation passed: desktop counters and mobile status selector are wired.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
