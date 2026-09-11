// End-to-end browser check for the demo. Requires `npm run build` and the demo
// server (default http://localhost:8089). Uses playwright-core with a local
// Chromium: set CHROME_PATH, or it looks for a Playwright cached headless
// shell, then Chrome Canary / Chrome.
//
// Asserts: the pipeline reaches "interactive"; interactions round-trip through
// the QuickJS worker and the sandboxed frame; focus survives updates; the
// attack sample yields no executable surface; the frame has a null origin;
// HTML sinks are blocked inside the frame; and no network request leaves for
// anything other than the demo server's own assets.
import { chromium, firefox } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.DEMO_URL || "http://localhost:8089/";

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const shells = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const s of shells) {
      const p = join(cache, s, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
      if (existsSync(p)) return p;
    }
  }
  for (const p of [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) if (existsSync(p)) return p;
  throw new Error("no Chromium found; set CHROME_PATH");
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); };

function findFirefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((d) => d.startsWith("firefox-")).sort().reverse()) {
      const p = join(cache, d, "firefox/Nightly.app/Contents/MacOS/firefox");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no Playwright Firefox found; set FIREFOX_PATH");
}

// BROWSER=firefox runs the same checks under Playwright's Firefox build.
const browser = process.env.BROWSER === "firefox"
  ? await firefox.launch({ executablePath: findFirefox(), headless: true })
  : await chromium.launch({ executablePath: findChrome(), headless: true });
console.log("browser:", browser.browserType().name(), browser.version());
const page = await browser.newPage();
const requests = [];
const consoleMessages = [];
page.on("request", (r) => requests.push(r.url()));
page.on("console", (m) => consoleMessages.push({ type: m.type(), text: m.text(), url: m.location().url }));
page.on("dialog", async (d) => { failures.push(`dialog opened: ${d.message()}`); await d.dismiss(); });

await page.goto(BASE);
await page.waitForFunction(() => /interactive|stopped|rejected/.test(document.getElementById("status").textContent), null, { timeout: 60000 });
const status1 = await page.textContent("#status");
check(/interactive/.test(status1), `benign sample reaches interactive state: "${status1}"`);

const frame = page.frames().find((f) => f !== page.mainFrame());
check(!!frame, "sandboxed frame exists");
check((await frame.evaluate(() => location.origin)) === "null", "frame origin is null (opaque)");
check((await frame.evaluate(() => document.querySelectorAll("rect").length)) === 4, "chart renders four bars");

const sinkResult = await frame.evaluate(() => {
  try { const d = document.createElement("div"); d.innerHTML = "<b>x</b>"; return d.childNodes.length ? "allowed" : "noop"; }
  catch (e) { return "blocked:" + e.name; }
});
check(sinkResult.startsWith("blocked"), `innerHTML inside frame is blocked (${sinkResult})`);

// Interaction round trip: click the counter button.
await frame.click("button[data-action=increment]");
await frame.waitForFunction(() => /Clicked 1/.test(document.body.textContent), null, { timeout: 10000 });
check(true, "click event round-trips through QuickJS worker and re-renders");

// Tabs and sorting.
await frame.click("button[data-action=tab][data-value=table]");
await frame.waitForSelector("table", { timeout: 10000 });
await frame.click("th[data-action=sort][data-value=q4]");
await frame.waitForFunction(() => document.querySelector("th[data-value=q4]").getAttribute("aria-sort") === "ascending", null, { timeout: 10000 });
const firstRegion = await frame.evaluate(() => document.querySelector("tbody td").textContent);
check(firstRegion === "West", `sorting by Q4 ascending puts West first (got ${firstRegion})`);

// Typing keeps focus and value across re-renders.
await frame.focus("input[data-action=filter]");
await frame.type("input[data-action=filter]", "no", { delay: 30 });
await frame.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1, null, { timeout: 10000 });
const focusState = await frame.evaluate(() => ({ focused: document.activeElement === document.querySelector("input[data-action=filter]"), value: document.querySelector("input[data-action=filter]").value }));
check(focusState.focused && focusState.value === "no", `focus and typed value survive re-render (${JSON.stringify(focusState)})`);

// Attack sample.
await page.click("#attack");
await page.waitForFunction(() => /AST gate|interactive|static document|rejected/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
await page.waitForFunction(() => /removed|REJECTED/.test(document.getElementById("report").textContent), null, { timeout: 30000 });
const status2 = await page.textContent("#status");
check(/rejected by AST gate/.test(status2), `attack JS rejected by AST gate: "${status2}"`);
const report = await page.textContent("#report");
check(/removed <script>/.test(report) && /removed <iframe>/.test(report), "report lists removed script and iframe");
const attackDom = await frame.evaluate(() => ({
  bad: Array.from(document.getElementById("root").querySelectorAll("script,style,img,iframe,object,embed,form,math,use,image,foreignObject,animate,a,link,meta,base,title")).map((e) => e.namespaceURI.split("/").pop() + ":" + e.localName),
  handlers: Array.from(document.getElementById("root").querySelectorAll("*")).filter((e) => Array.from(e.attributes).some((a) => /^on|^style$|href|src/i.test(a.name))).length,
  passwordInputs: document.querySelectorAll("input[type=password]").length,
  autocomplete: Array.from(document.querySelectorAll("input,select,textarea")).every((e) => e.getAttribute("autocomplete") === "off"),
  ids: Array.from(document.querySelectorAll("[id]")).map((e) => e.id).filter((id) => id !== "root"),
  text: document.body.textContent,
}));
check(attackDom.bad.length === 0, `attack sample: no executable or fetching elements in frame (${attackDom.bad.join(",") || "none"})`);
check(attackDom.handlers === 0, "attack sample: no handler, style or URL attributes in frame");
check(attackDom.passwordInputs === 0 && attackDom.autocomplete, "attack sample: no password inputs, autocomplete off");
check(attackDom.ids.every((id) => id.startsWith("g-")), `attack sample: generated ids are prefixed (${attackDom.ids.join(",")})`);
check(/Visible text with bidi/.test(attackDom.text) && !/‮/.test(attackDom.text), "attack sample: text kept, bidi override stripped");

// Standalone attack showcase: every scenario is independently checked and
// rendered through the same built frame artifact.
await page.goto(new URL("/demo/showcase.html", BASE).href);
await page.waitForFunction(() => document.getElementById("verdict").textContent === "Protected and rendered", null, { timeout: 30000 });
const showcaseFrame = page.frames().find((f) => f !== page.mainFrame());
check(!!showcaseFrame, "attack showcase creates a sandboxed frame");
check((await showcaseFrame.evaluate(() => location.origin)) === "null", "attack showcase frame origin is null");
const caseButtons = await page.locator(".case-button").count();
check(caseButtons === 6, `attack showcase exposes six scenarios (got ${caseButtons})`);
for (let i = 0; i < caseButtons; i++) {
  await page.locator(".case-button").nth(i).click();
  await page.waitForFunction(() => document.getElementById("verdict").textContent === "Protected and rendered", null, { timeout: 10000 });
  const title = await page.textContent("#case-title");
  const count = await page.textContent("#change-count");
  const filtered = await page.textContent("#filtered-html");
  check(/transformation/.test(count), `showcase scenario "${title}" reports policy transformations`);
  check(filtered.length > 0 && !/<script|\son[a-z]+=|https:\/\/attacker\.invalid/i.test(filtered),
    `showcase scenario "${title}" displays filtered HTML without the attack surface`);
}
const showcaseSurface = await showcaseFrame.evaluate(() => ({
  dangerous: document.getElementById("root").querySelectorAll("script,style,img,iframe,object,embed,form,math,use,image,foreignObject,animate,a,link,meta,base").length,
  dangerousAttrs: Array.from(document.getElementById("root").querySelectorAll("*")).filter((e) => Array.from(e.attributes).some((a) => /^on|^style$|href|src/i.test(a.name))).length,
}));
check(showcaseSurface.dangerous === 0 && showcaseSurface.dangerousAttrs === 0,
  "showcase final scenario contains no executable, fetching, or URL surface");

// Network: only our own assets.
const foreign = requests.filter((u) => !u.startsWith(BASE));
check(foreign.length === 0, `no requests to foreign origins (${requests.length} total, foreign: ${foreign.join(", ") || "none"})`);
check(!requests.some((u) => /example\.invalid/.test(u)), "no request to any attacker URL");

// Violations reported from inside the frame would mean the frame tried to do
// something its own policy forbids. Reports from the host page's inert
// DOMParser document (Chrome evaluates CSP there too) are expected: they are
// the attack markup being parsed, not applied.
const frameViolations = consoleMessages.filter((m) => /Content Security Policy/.test(m.text) && m.url === "about:srcdoc");
const hostViolations = consoleMessages.filter((m) => /Content Security Policy/.test(m.text) && m.url !== "about:srcdoc");
check(frameViolations.length === 0, `no CSP violations inside the frame (${frameViolations.length}; host-side inert-parse reports: ${hostViolations.length})`);

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  for (const m of consoleMessages) console.error("console:", m.type, m.url, m.text.slice(0, 200));
  process.exit(1);
}
console.log("\nall browser checks passed");
