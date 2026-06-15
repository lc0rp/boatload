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
assert(stylesCss.includes("overflow-wrap: anywhere"), "expected long mobile text to wrap instead of forcing horizontal scroll");
assert(stylesCss.includes(".layout { height: auto; grid-template-columns: 1fr; }"), "expected mobile layout to collapse to one column");
assert(stylesCss.includes(".talk-box, .comment-box { grid-template-columns: 1fr; }"), "expected mobile input actions to stack vertically");
assert(stylesCss.includes(".rail, .detail { max-height: none; overflow: visible; width: 100%; }"), "expected mobile panes to stay within viewport width");

console.log("UI validation passed: status counters are the only status filter surface.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
