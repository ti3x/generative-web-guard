// End-to-end browser checks for the demo, on PINNED engine builds.
//
// Requires `npm run build` and the demo server:
//   PORT=8096 npm run serve
//   DEMO_URL=http://localhost:8096/ npm run check:browser
//
// ENGINE PINNING. This script used to pick "the newest Playwright build in the
// local cache", which is how the project ended up with two different version
// sets in circulation: the CSP spike measured Chromium 140.0.7339.186,
// Firefox 141.0 and WebKit 26.0, while a concurrent run of this script
// reported Chromium 153 and Firefox 146 from newer cached builds. A support
// matrix quoting two version sets is not evidence, so the revisions are pinned
// here and the launched build's reported version is ASSERTED. A mismatch is a
// failure, not a warning, and there is no silent fallback to a different
// build. Set CHROME_PATH / FIREFOX_PATH / WEBKIT_PATH to test something else
// deliberately; then EXPECT_PINNED_VERSIONS=0 to allow the version mismatch.
//
// Firefox 1490 and WebKit 2203 are exactly the revisions playwright-core
// 1.55.0 pins. Chromium is the one exception: playwright-core pins revision
// 1187 (140.0.7339.16), which is not present locally, so the preferred build
// is 1193 (140.0.7339.186) -- the build the spike measured and the one
// docs/csp.md records results for. 1187 is also accepted, so a runner that
// installed browsers with playwright-core can run this script; whichever
// build ran is printed in the notes at the end. docs/csp.md records this.
//
// WHAT IS ASSERTED, on every engine:
//   * the benign sample reaches "interactive"; interactions round-trip through
//     the QuickJS Worker and the sandboxed frame; focus survives updates;
//   * the attack sample yields no executable surface and fails inside QuickJS
//     rather than in a static gate;
//   * hostile markup is preprocessed in the policy Worker without blocking the
//     host UI, and a request over budget terminates that Worker and settles;
//   * the frame has a null origin and HTML sinks are blocked inside it;
//   * PROFILE A: a module loaded from a DIFFERENT ORIGIN creates both Workers
//     from blob: URLs, creates the frame, compiles Wasm, and commits renders;
//   * the per-stage startup codes are reachable: with one required token
//     removed from the host policy (serve.mjs ?cspOmit=...), the failing stage
//     reports its own code, and the frame case reports it with no
//     securitypolicyviolation event anywhere;
//   * no network request leaves for anything but the demo server and the CDN
//     origin.
import { chromium, firefox, webkit } from "playwright-core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.DEMO_URL || "http://localhost:8089/";
const baseUrl = new URL(BASE);
const CDN_ORIGIN = process.env.CDN_URL
  || `http://127.0.0.1:${Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80)) + 1}`;
// Playwright's browser cache. PLAYWRIGHT_BROWSERS_PATH is honoured so this
// works on a CI runner as well as a macOS developer machine.
const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (process.platform === "darwin"
    ? join(homedir(), "Library/Caches/ms-playwright")
    : join(homedir(), ".cache/ms-playwright"));
const expectPinned = process.env.EXPECT_PINNED_VERSIONS !== "0";

// Per engine: the accepted revisions, in preference order, and the engine
// versions those revisions report. Both lists are closed on purpose. Anything
// else has to be selected explicitly with the env override, because picking
// "whatever is newest in the cache" is what produced two conflicting version
// sets in this project's claims.
const ENGINES = {
  chromium: {
    type: chromium,
    envVar: "CHROME_PATH",
    // 1193 is the installed build the CSP spike measured and the one
    // docs/csp.md records results for. 1187 is playwright-core 1.55.0's own
    // pin and is what `playwright-core install` provides; it is accepted so a
    // CI runner can run this script, and the version it reports is printed.
    revisions: [
      { revision: "1193", version: "140.0.7339.186" },
      { revision: "1187", version: "140.0.7339.16" },
    ],
    relative: [
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
    ],
  },
  firefox: {
    type: firefox,
    envVar: "FIREFOX_PATH",
    revisions: [{ revision: "1490", version: "141.0" }],
    relative: [
      "firefox/Nightly.app/Contents/MacOS/firefox",
      "firefox/firefox",
    ],
  },
  webkit: {
    type: webkit,
    envVar: "WEBKIT_PATH",
    revisions: [{ revision: "2203", version: "26.0" }],
    relative: ["pw_run.sh"],
  },
};

const selected = (process.env.ENGINES || "chromium,firefox,webkit")
  .split(",").map((s) => s.trim()).filter(Boolean);
for (const name of selected) {
  if (!ENGINES[name]) throw new Error(`unknown engine: ${name} (expected chromium, firefox or webkit)`);
}

function resolveExecutable(name) {
  const spec = ENGINES[name];
  const override = process.env[spec.envVar];
  if (override) return { path: override, pinned: null };
  const tried = [];
  for (const pin of spec.revisions) {
    for (const rel of spec.relative) {
      const candidate = join(pwCache, `${name}-${pin.revision}`, rel);
      tried.push(candidate);
      if (existsSync(candidate)) return { path: candidate, pinned: pin };
    }
  }
  throw new Error(
    `${name}: no pinned Playwright revision (${spec.revisions.map((p) => p.revision).join(", ")}) is installed.\n`
    + `Tried:\n  ${tried.join("\n  ")}\n`
    + `Install one, or set ${spec.envVar} deliberately together with EXPECT_PINNED_VERSIONS=0. `
    + `Silently falling back to a different cached build is what produced two conflicting version sets.`,
  );
}

const failures = [];
const notes = [];
let engineLabel = "";
const check = (cond, msg) => {
  if (!cond) failures.push(`[${engineLabel}] ${msg}`);
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
};
const note = (msg) => { notes.push(`[${engineLabel}] ${msg}`); console.log(`note  ${msg}`); };

// ---------------------------------------------------------------------------

async function runEngine(name) {
  const spec = ENGINES[name];
  const { path, pinned } = resolveExecutable(name);
  const browser = await spec.type.launch({ executablePath: path, headless: true });
  const version = browser.version();
  engineLabel = `${name} ${version}`;
  console.log(`\n=== ${name} ${version} (${pinned ? `pinned revision ${pinned.revision}` : `${spec.envVar} override`})`);
  // The matrix in docs/csp.md quotes exact versions; if the binary is not one
  // of the pinned builds the matrix stops being evidence.
  if (!expectPinned) {
    note(`version assertion disabled; running ${name} ${version} from ${path}`);
  } else if (pinned === null) {
    check(false, `${name}: ${spec.envVar} was set without EXPECT_PINNED_VERSIONS=0 (running ${version})`);
  } else {
    check(version === pinned.version,
      `engine is the pinned build for revision ${pinned.revision}: ${pinned.version} (got ${version})`);
  }
  note(`ran on ${name} ${version}${pinned ? ` (Playwright revision ${pinned.revision})` : ""}`);

  try {
    await checkDemo(browser, name);
    await checkCrossOriginCdn(browser, name);
    await checkStartupCodes(browser, name);
  } finally {
    await browser.close();
  }
}

function instrument(page, sink) {
  page.on("request", (r) => sink.requests.push(r.url()));
  page.on("console", (m) => sink.console.push({ type: m.type(), text: m.text(), url: m.location().url }));
  page.on("pageerror", (e) => sink.console.push({ type: "pageerror", text: String(e.message), url: "" }));
  page.on("dialog", async (d) => { failures.push(`dialog opened: ${d.message()}`); await d.dismiss(); });
}

// Count securitypolicyviolation events the HOST document actually receives.
// This is the N8 measurement: for a frame CSP failure the answer is zero.
const VIOLATION_PROBE = `
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120) });
  });
`;

// ---------------------------------------------------------------------------
// 1. The demo, under Profile A with nothing omitted.

async function checkDemo(browser, engine) {
  const sink = { requests: [], console: [] };
  const page = await browser.newPage();
  instrument(page, sink);
  await page.addInitScript(VIOLATION_PROBE);

  await page.goto(BASE);
  await page.waitForFunction(
    () => /interactive|stopped|rejected|failed/.test(document.getElementById("status").textContent),
    null, { timeout: 60000 },
  );
  const status1 = await page.textContent("#status");
  check(/interactive/.test(status1), `benign sample reaches interactive state under Profile A: "${status1}"`);

  // Both Workers are blob: Workers created from payloads embedded in the
  // bundle. A same-origin script URL would not inherit this document's CSP.
  const startupLog = await page.evaluate(() => window.__guardPolicyProbe.startupLog());
  check(startupLog.some((l) => /policy worker: channel handshake complete/.test(l)),
    `policy Worker completed the channel-handshake stage (${startupLog.length} startup notes)`);
  check(startupLog.some((l) => /quickjs worker: wasm-init stage complete/.test(l)),
    "QuickJS Worker completed the wasm-init stage inside a blob: Worker");
  // The Lean/Wasm acceptance authority, instantiated from the binary embedded
  // in the Worker payload. Nothing can be accepted before this stage, and
  // there is no fallback if it fails.
  check(startupLog.some((l) => /policy worker: lean checker ready/.test(l)),
    "policy Worker instantiated the Lean/Wasm checker inside a blob: Worker");
  const checkerReady = await page.evaluate(() => window.__guardPolicyProbe.checkerReady());
  check(checkerReady.ok === true, `Lean checker reported ready (${JSON.stringify(checkerReady).slice(0, 200)})`);
  check(checkerReady.ok && /^guard-checker\/\d+\.\d+$/.test(checkerReady.checker.checkerVersion),
    `Lean checker identity: ${checkerReady.ok ? JSON.stringify(checkerReady.checker) : "unknown"}`);
  check(checkerReady.ok && checkerReady.checker.profile === "default",
    "the checker applies the single shipped profile");
  check(checkerReady.ok && checkerReady.checker.wasmBytes > 500_000,
    `the embedded checker binary is the real one (${checkerReady.ok ? checkerReady.checker.wasmBytes : 0} bytes)`);
  const frameReady = await page.evaluate(() => window.__guardPolicyProbe.frameReady());
  check(frameReady.ok === true, `frame completed the frame-bootstrap stage (${JSON.stringify(frameReady)})`);
  check(frameReady.ok && frameReady.info.styleSheets > 0,
    "frame stylesheet applied, so no frame-style-hash-missing warning");
  // Trusted Types is a Chromium/WebKit-only layer: Firefox 141 does not
  // implement require-trusted-types-for/trusted-types at all. Record what the
  // engine actually provided instead of implying uniform coverage.
  note(`frame trustedTypes available: ${frameReady.ok ? frameReady.info.trustedTypes : "unknown"}`);
  if (engine === "firefox") {
    check(frameReady.ok && frameReady.info.trustedTypes === false,
      "Firefox: Trusted Types absent in the frame, as documented (sink hardening is the equivalent there)");
  } else {
    check(frameReady.ok && frameReady.info.trustedTypes === true,
      `${engine}: Trusted Types present in the frame`);
  }

  const frame = page.frames().find((f) => f !== page.mainFrame());
  check(!!frame, "sandboxed frame exists");
  check((await frame.evaluate(() => location.origin)) === "null", "frame origin is null (opaque)");
  check((await frame.evaluate(() => document.querySelectorAll("rect").length)) === 4, "chart renders four bars");

  const sinkResult = await frame.evaluate(() => {
    try { const d = document.createElement("div"); d.innerHTML = "<b>x</b>"; return d.childNodes.length ? "allowed" : "noop"; }
    catch (e) { return "blocked:" + e.name; }
  });
  check(sinkResult.startsWith("blocked"), `innerHTML inside frame is blocked (${sinkResult})`);

  // NOT asserted via Playwright's evaluate(): that eval is blocked. evaluate()
  // runs through the debugger protocol, which bypasses CSP, so a result of 2
  // would prove nothing. Instead the page's own probe runs inside a blob:
  // Worker that inherits this document's policy, which is where it matters.
  const wasm = await page.evaluate(() => window.__guardPolicyProbe.wasmProbe());
  check(wasm.blobWorker.created === true, "the probe blob: Worker was created under Profile A");
  check(wasm.blobWorker.wasmInstantiate === "ok" && wasm.blobWorker.wasmSync === "ok",
    `Profile A: Wasm compiles inside the blob: Worker (${JSON.stringify(wasm.blobWorker).slice(0, 300)})`);
  // The central safety property of using 'wasm-unsafe-eval' rather than
  // 'unsafe-eval': string evaluation stays blocked in the realm that inherits
  // the policy. Measured on each engine, not quoted.
  check(String(wasm.blobWorker.eval).startsWith("refused"),
    `Profile A: eval is still blocked inside the blob: Worker (${String(wasm.blobWorker.eval).slice(0, 120)})`);
  check(String(wasm.blobWorker.newFunction).startsWith("refused"),
    `Profile A: new Function is still blocked inside the blob: Worker (${String(wasm.blobWorker.newFunction).slice(0, 120)})`);

  await frame.click("button[data-action=increment]");
  await frame.waitForFunction(() => /Clicked 1/.test(document.body.textContent), null, { timeout: 10000 });
  check(true, "click event round-trips through QuickJS worker and re-renders");

  await frame.click("button[data-action=tab][data-value=table]");
  await frame.waitForSelector("table", { timeout: 10000 });
  await frame.click("th[data-action=sort][data-value=q4]");
  await frame.waitForFunction(() => document.querySelector("th[data-value=q4]").getAttribute("aria-sort") === "ascending", null, { timeout: 10000 });
  const firstRegion = await frame.evaluate(() => document.querySelector("tbody td").textContent);
  check(firstRegion === "West", `sorting by Q4 ascending puts West first (got ${firstRegion})`);

  await frame.focus("input[data-action=filter]");
  await frame.type("input[data-action=filter]", "no", { delay: 30 });
  await frame.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1, null, { timeout: 10000 });
  const focusState = await frame.evaluate(() => ({
    focused: document.activeElement === document.querySelector("input[data-action=filter]"),
    value: document.querySelector("input[data-action=filter]").value,
  }));
  check(focusState.focused && focusState.value === "no", `focus and typed value survive re-render (${JSON.stringify(focusState)})`);

  // Attack sample, part 1: the malicious PROGRAM. With a program supplied the
  // integrated API renders its first view, not the HTML, so this exercises the
  // program path -- and the attack program reaches for host capabilities that
  // do not exist inside QuickJS, so it is refused there. The supplied HTML is
  // NOT rendered as a fallback (that is the contract), which the DOM check
  // below relies on.
  await page.click("#attack");
  await page.waitForFunction(
    () => /QuickJS refused the program/.test(document.getElementById("report").textContent),
    null, { timeout: 30000 },
  );
  const status2 = await page.textContent("#status");
  const report = await page.textContent("#report");
  check(/failed in QuickJS/.test(status2), `attack JS fails inside QuickJS, not in a static gate: "${status2}"`);
  check(/QuickJS refused the program/.test(report), "report attributes the program failure to QuickJS");
  // A guest program that will not run must never be reported as a startup or
  // CSP problem: that would send the host to change a header it does not need.
  check(!/StartupError|csp-/.test(report), "a refused program is not misreported as a CSP startup failure");

  // Attack sample, part 2: the malicious MARKUP. Rendered as a static document
  // (no program), so the policy strips the dangerous elements and the frame
  // shows the cleaned tree. This is where the DOM-sanitization proof lives.
  await page.fill("#js", "");
  await page.click("#run");
  await page.waitForFunction(
    () => /removed &lt;script&gt;|removed <script>/.test(document.getElementById("report").textContent),
    null, { timeout: 30000 },
  );
  const markupReport = await page.textContent("#report");
  check(/removed <script>/.test(markupReport) && /removed <iframe>/.test(markupReport), "static attack markup: report lists removed script and iframe");
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

  // R3 exit gate in a real browser: hostile preprocessing must not block the
  // host UI, and a request over budget must terminate the policy Worker and
  // still settle.
  const responsiveness = await page.evaluate(async () => {
    const html = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
    let last = performance.now();
    let worstGapMs = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - last);
      last = now;
      ticks++;
    }, 10);
    const started = performance.now();
    const deep = await window.__guardPolicyProbe.preprocess(html);
    const wide = await window.__guardPolicyProbe.preprocess("<p a=1>x</p>".repeat(33000));
    const elapsedMs = performance.now() - started;
    clearInterval(timer);
    return { deep, wide, worstGapMs, ticks, elapsedMs };
  });
  check(responsiveness.deep.status === "rejected" && responsiveness.deep.reason.code === "raw-depth-exceeded",
    `5,000 nested elements are rejected by a limit (${JSON.stringify(responsiveness.deep.reason)})`);
  check(responsiveness.wide.status === "rejected" && responsiveness.wide.reason.code === "raw-path-nodes-exceeded",
    `a 400,000 character document is rejected by a limit (${JSON.stringify(responsiveness.wide.reason)})`);
  check(responsiveness.ticks > 0 && responsiveness.worstGapMs < 250,
    `host event loop stays responsive during hostile preprocessing (${responsiveness.ticks} ticks, worst gap ${responsiveness.worstGapMs.toFixed(1)} ms over ${responsiveness.elapsedMs.toFixed(1)} ms)`);

  // A document that is expensive but LEGAL: one text node just under
  // maxRawTextCodeUnits. A wide document would be refused by maxRawPathNodes
  // before the 1 ms budget could fire, which would test the wrong thing.
  const timeout = await page.evaluate(async () => {
    const limits = window.__guardPolicyProbe.limits();
    return window.__guardPolicyProbe.forceTimeout(`<p>${"x".repeat(limits.maxRawTextCodeUnits - 1000)}</p>`);
  });
  check(timeout.status === "rejected" && timeout.code === "timeout",
    `a request over its budget settles as a timeout (${JSON.stringify(timeout)})`);
  check(timeout.terminated && timeout.sessionChanged && timeout.pending === 0,
    "the timeout terminated the policy Worker, changed the session, and left nothing pending");
  const recovered = await page.evaluate(() => window.__guardPolicyProbe.recover());
  check(recovered.status === "accepted", `the next request runs on a fresh policy Worker (${JSON.stringify(recovered)})`);

  // ---- the acceptance binding, measured on the shipped bytes ------------
  // A fabricated record and a bare tree must both fail to commit, and a
  // genuine record must be one-time. These are the same negative controls the
  // unit tests run, re-measured in a real engine on the built bundle.
  const acceptance = await page.evaluate(() => window.__guardPolicyProbe.acceptanceControls());
  check(acceptance.accepted === true, `policy Worker accepted the control document (${JSON.stringify(acceptance).slice(0, 200)})`);
  check(acceptance.authority === "lean-wasm", `the authority is Lean/Wasm, reported honestly (${acceptance.authority})`);
  check(acceptance.forgedRendered === false, "a fabricated acceptance record does not render");
  check(acceptance.bareTreeRendered === false, "a bare accepted tree does not render: the frame takes records only");
  check(acceptance.genuine === true, "a genuine acceptance record can be claimed once");
  check(acceptance.replayed === false, "a replayed acceptance record is refused");

  // ---- the open-node path bound, measured in THIS engine -----------------
  // maxRawPathNodes exists because the Lean checker recurses once per sibling
  // on the engine's own call stack, which no build flag configures. What it
  // has open when it reaches a node is that node's ancestors, itself and every
  // earlier sibling of each -- for a flat list, the node's position. Measured
  // thresholds for flat lists: Node 22/V8 9,000 fine and 9,500 overflowed;
  // Firefox 141 5,800 fine and 6,000 overflowed; WebKit 26 2,000 fine over ten
  // calls and 2,500 overflowed on the second identical call. The configured
  // bound is 1,000. What must hold on every engine is that a document AT the
  // bound gets a structured answer and leaves the Worker alive, and one node
  // past it is refused by preprocessing.
  // `<p></p>` is one raw node, so these are exactly maxRawPathNodes and one
  // more. The number comes from the shipped bundle's own limits, not from a
  // literal here, so the check cannot drift from the build.
  const bound = await page.evaluate(async () => {
    const limits = window.__guardPolicyProbe.limits();
    return window.__guardPolicyProbe.siblingBound(limits.maxRawPathNodes, limits.maxRawPathNodes + 1);
  });
  check(["accepted", "rejected"].includes(bound.at.status),
    `a document at maxRawPathNodes gets a structured answer, not a crash (${JSON.stringify(bound.at)})`);
  check(bound.aliveAfterLimit === true, "the policy Worker survives a document at maxRawPathNodes");
  check(bound.past.status === "rejected" && bound.past.code === "raw-path-nodes-exceeded" && bound.past.limit === "maxRawPathNodes",
    `one node past maxRawPathNodes is refused by preprocessing (${JSON.stringify(bound.past)})`);
  check(bound.aliveAtEnd === true, "the policy Worker survives both");
  note(`open-node path bound on this engine: ${JSON.stringify(bound)}`);

  // The bound is on SHAPE, not size, and that has to hold in the engine, not
  // only in Node: a wide, shallow document with more raw nodes than the path
  // bound must be accepted, and the deepest, widest shape the frontend permits
  // -- maxRawDepth levels with earlier siblings open at every one -- must get
  // a structured policy answer three times running with the Worker alive. The
  // second point is where nesting's extra frames per level would show up.
  const shape = await page.evaluate(async () => {
    const limits = window.__guardPolicyProbe.limits();
    const cell = (r, c) => `<td>${r}-${c}</td>`;
    const table = `<table><tbody>${Array.from({ length: 100 }, (_, r) => `<tr>\n${Array.from({ length: 8 }, (_, c) => cell(r, c)).join("\n")}\n</tr>`).join("\n")}</tbody></table>`;
    const wide = await window.__guardPolicyProbe.preprocess(table);
    const levels = limits.maxRawDepth - 2;
    const beside = Math.floor(limits.maxRawPathNodes / levels) - 1; // earlier siblings per level
    const deep = `<div>${"<p></p>".repeat(beside)}`.repeat(levels) + "x" + "</div>".repeat(levels);
    const deepResults = [];
    for (let i = 0; i < 3; i++) deepResults.push(await window.__guardPolicyProbe.preprocess(deep));
    return { wide, deepResults, levels, beside };
  });
  check(shape.wide.status === "accepted",
    `a 100x8 table, over 2,000 raw nodes with about 200 open at most, is accepted (${JSON.stringify(shape.wide).slice(0, 160)})`);
  check(shape.deepResults.every((r) => r.status === "rejected" && r.reason && r.reason.code === "lean-rejected"),
    `the deepest, widest permitted shape (${shape.levels} levels, ${shape.beside} earlier siblings each) is answered by the policy, not a trap, three times (${JSON.stringify(shape.deepResults.map((r) => r.status + ":" + (r.reason && r.reason.code)))})`);
  note(`worst permitted shape on this engine: ${JSON.stringify(shape.deepResults[2]).slice(0, 200)}`);

  // ---- the checker is embedded, not fetched ------------------------------
  // A fetched .wasm would need connect-src, and Profile A ships
  // connect-src 'none'. Measure that no request for it is ever made.
  const wasmRequests = sink.requests.filter((u) => /\.wasm(\?|$)/.test(u) || /guard\.wasm/.test(u));
  check(wasmRequests.length === 0, `no request for a .wasm asset: the checker is embedded (${wasmRequests.join(", ") || "none"})`);


  // Standalone attack showcase.
  await page.goto(new URL("/demo/showcase.html", BASE).href);
  // The verdict names the authority that accepted the document, so match the
  // prefix rather than the whole string.
  await page.waitForFunction(() => /^Protected and rendered/.test(document.getElementById("verdict").textContent), null, { timeout: 30000 });
  check(/accepted by lean-wasm/.test(await page.locator("#verdict").textContent()),
    "attack showcase attributes its render to the Lean/Wasm authority");
  const showcaseFrame = page.frames().find((f) => f !== page.mainFrame());
  check(!!showcaseFrame, "attack showcase creates a sandboxed frame");
  check((await showcaseFrame.evaluate(() => location.origin)) === "null", "attack showcase frame origin is null");
  const caseButtons = await page.locator(".case-button").count();
  check(caseButtons === 7, `attack showcase exposes seven scenarios (got ${caseButtons})`);
  for (let i = 0; i < caseButtons - 1; i++) {
    await page.locator(".case-button").nth(i).click();
    await page.waitForFunction(() => /^Protected and rendered/.test(document.getElementById("verdict").textContent), null, { timeout: 10000 });
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

  await page.locator(".case-button").nth(caseButtons - 1).click();
  await page.waitForFunction(() => /Rejected in the policy worker/.test(document.getElementById("verdict").textContent), null, { timeout: 15000 });
  const limitVerdict = await page.textContent("#verdict");
  const limitReport = await page.textContent("#report");
  check(/raw-depth-exceeded/.test(limitVerdict), `showcase limit scenario is rejected by a preprocessing limit ("${limitVerdict}")`);
  check(/maxRawDepth/.test(limitReport), "showcase limit scenario names the exceeded limit");
  const clearedFrame = await showcaseFrame.evaluate(() => document.getElementById("root")?.childNodes.length ?? -1);
  check(clearedFrame === 0, `showcase limit scenario renders nothing (frame children: ${clearedFrame})`);

  // The checker is embedded, not fetched: a fetched .wasm would need
  // connect-src, and Profile A ships connect-src 'none'. Checked over every
  // request the demo pages made, including the showcase.
  const allWasmRequests = sink.requests.filter((u) => /\.wasm(\?|$)/.test(u) || /guard\.wasm/.test(u));
  check(allWasmRequests.length === 0, `no request for a .wasm asset on any demo page: the checker is embedded (${allWasmRequests.join(", ") || "none"})`);

  // Network: only our own assets. The demo pages never touch the CDN origin.
  // blob: and data: URLs are recorded as "requests" but never leave the
  // process; only http(s) requests are network egress.
  const network = sink.requests.filter((u) => /^https?:/.test(u));
  const foreign = network.filter((u) => !u.startsWith(BASE));
  check(foreign.length === 0, `demo pages: no requests to foreign origins (${network.length} network, ${sink.requests.length} total, foreign: ${foreign.join(", ") || "none"})`);
  check(!sink.requests.some((u) => /example\.invalid|attacker\.invalid/.test(u)), "no request to any attacker URL");

  // Violations reported from inside the frame would mean the frame tried to do
  // something its own policy forbids. Reports from the host page's inert
  // DOMParser document (Chrome evaluates CSP there too) are expected.
  const frameViolations = sink.console.filter((m) => /Content Security Policy/.test(m.text) && m.url === "about:srcdoc");
  const hostViolations = sink.console.filter((m) => /Content Security Policy/.test(m.text) && m.url !== "about:srcdoc");
  check(frameViolations.length === 0, `no CSP violations inside the frame (${frameViolations.length}; host-side inert-parse reports: ${hostViolations.length})`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 2. Profile A's actual claim: the library loaded from a DIFFERENT ORIGIN
//    creates both Workers from blob: URLs and commits renders.

async function checkCrossOriginCdn(browser, engine) {
  const sink = { requests: [], console: [] };
  const page = await browser.newPage();
  instrument(page, sink);
  const url = new URL("/demo/cdn.html", BASE);
  url.searchParams.set("cdn", CDN_ORIGIN);
  await page.goto(url.href);
  await page.waitForFunction(() => window.__guardCdnProbe && window.__guardCdnProbe.done(), null, { timeout: 90000 });
  const stages = await page.evaluate(() => window.__guardCdnProbe.stages());
  const byName = new Map(stages.map((s) => [s.name, s]));
  const show = () => JSON.stringify(stages);

  check(byName.get("cdn-import")?.ok === true, `cross-origin module import succeeded from ${CDN_ORIGIN} (${show()})`);
  check(byName.get("cdn-import")?.detail?.crossOrigin === true,
    `the bundle really came from another origin (${JSON.stringify(byName.get("cdn-import")?.detail)})`);
  check(byName.get("frame-bootstrap")?.ok === true, "cross-origin bundle created the opaque frame and it bootstrapped");
  check(byName.get("policy-worker-handshake")?.ok === true, "cross-origin bundle created the policy Worker from a blob: URL and completed the handshake");
  check(byName.get("lean-checker-ready")?.ok === true, `the cross-origin bundle instantiated the embedded Lean checker (${JSON.stringify(byName.get("lean-checker-ready")?.detail)})`);
  check(byName.get("policy-accept")?.ok === true, "the cross-origin policy Worker accepted the benign document");
  check(byName.get("policy-accept")?.detail?.authority === "lean-wasm",
    `the cross-origin path reports the Lean authority (${JSON.stringify(byName.get("policy-accept")?.detail)})`);
  check(byName.get("bare-tree-refused")?.ok === true, "the cross-origin frame refuses a bare accepted tree");
  check(byName.get("frame-commit")?.ok === true, "the frame acknowledged the commit");
  check(byName.get("replay-refused")?.ok === true, "the cross-origin frame refuses a replayed acceptance record");
  check(byName.get("wasm-init")?.ok === true, "QuickJS compiled Wasm inside the blob: Worker, which inherits the host policy");
  check(byName.get("view-commit")?.ok === true, `the generated view was validated and committed (${show()})`);

  const cdnFrame = page.frames().find((f) => f !== page.mainFrame());
  const cdnWasmRequests = sink.requests.filter((u) => /\.wasm(\?|$)/.test(u) || /guard\.wasm/.test(u));
  check(cdnWasmRequests.length === 0, `cross-origin path: no request for a .wasm asset (${cdnWasmRequests.join(", ") || "none"})`);
  check((await cdnFrame.evaluate(() => location.origin)) === "null", "cross-origin path: frame origin is still null");
  // Interaction through the cross-origin bundle.
  await cdnFrame.click("button[data-action=increment]");
  await cdnFrame.waitForFunction(() => /Clicked 1/.test(document.body.textContent), null, { timeout: 20000 });
  check(true, "cross-origin path: an interaction round-trips and re-renders");

  // Only the demo origin and the CDN origin.
  const network = sink.requests.filter((u) => /^https?:/.test(u));
  const unexpected = network.filter((u) => !u.startsWith(BASE) && !u.startsWith(CDN_ORIGIN));
  check(unexpected.length === 0, `cross-origin page: only the demo and CDN origins were contacted (${unexpected.join(", ") || "none"})`);
  const usedCdn = network.filter((u) => u.startsWith(CDN_ORIGIN));
  check(usedCdn.length > 0, `the bundle was actually fetched from the CDN origin (${usedCdn.length} request(s))`);
  // No Worker was fetched from either origin by URL: the payload travels
  // inside the module, because a cross-origin Worker URL cannot work at all.
  check(!sink.requests.some((u) => /worker\.min\.js|policy-worker\.min\.js|\/dist\/worker\.js|\/dist\/policy-worker\.js/.test(u)),
    "no Worker script was fetched by URL; both payloads came from the module");
  await page.close();
}

// ---------------------------------------------------------------------------
// 3. The per-stage startup codes, each produced by removing exactly one
//    required token from the host policy.

async function checkStartupCodes(browser, engine) {
  // --- frame script hash removed: no violation report anywhere, only a
  //     timeout. This is the case the report says must be timeout-driven.
  {
    const sink = { requests: [], console: [] };
    const page = await browser.newPage();
    instrument(page, sink);
    await page.addInitScript(VIOLATION_PROBE);
    await page.goto(new URL("/?cspOmit=frameScriptHash", BASE).href);
    await page.waitForFunction(() => !!window.__guardPolicyProbe, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__guardPolicyProbe.frameReady());
    check(result.ok === false && result.code === "frame-bootstrap-timeout",
      `omitting the frame script hash yields frame-bootstrap-timeout (${JSON.stringify(result)})`);
    const frameText = `${result.hint ?? ""} ${result.detail ?? ""}`;
    check(/sha256-/.test(frameText) && /script-src/.test(frameText) && /style-src/.test(frameText),
      `the frame-bootstrap-timeout message names both required hashes (${frameText.slice(0, 400)})`);
    const violations = await page.evaluate(() => window.__cspViolations);
    // N8: nothing reports the frame's refused inline script. Unrelated
    // host-document reports (Firefox reports the browser's own favicon probe
    // against img-src) are noise, so the assertion is about script/style
    // reports, which are the only ones that could name this failure.
    const relevant = violations.filter((v) => /script|style/.test(v.directive));
    note(`host securitypolicyviolation events with the frame script hash omitted: ${JSON.stringify(violations)}`);
    check(relevant.length === 0,
      `no script/style securitypolicyviolation reaches the host for the frame's failure (${JSON.stringify(relevant)}) -- the timeout is the only signal`);
    await page.close();
  }

  // --- frame style hash removed: the frame works, unstyled. The frame can
  //     see that its own stylesheet did not apply even though it cannot see
  //     the violation, so this warns and startup still succeeds.
  {
    const sink = { requests: [], console: [] };
    const page = await browser.newPage();
    instrument(page, sink);
    await page.goto(new URL("/?cspOmit=frameStyleHash", BASE).href);
    await page.waitForFunction(() => !!window.__guardPolicyProbe, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__guardPolicyProbe.frameReady());
    check(result.ok === true && result.info.styleSheets === 0,
      `omitting the frame style hash still bootstraps the frame, unstyled (${JSON.stringify(result)})`);
    const log = await page.evaluate(() => window.__guardPolicyProbe.startupLog());
    check(log.some((l) => /frame-style-hash-missing/.test(l)),
      `the missing style hash is reported as a warning, not a failure (${JSON.stringify(log).slice(0, 300)})`);
    await page.waitForFunction(
      () => /interactive|stopped|rejected|failed/.test(document.getElementById("status").textContent),
      null, { timeout: 60000 },
    );
    check(/interactive/.test(await page.textContent("#status")),
      "an unstyled frame is still fully functional");
    await page.close();
  }

  // --- blob: removed from worker-src: the Worker cannot be created.
  {
    const sink = { requests: [], console: [] };
    const page = await browser.newPage();
    instrument(page, sink);
    await page.addInitScript(VIOLATION_PROBE);
    await page.goto(new URL("/?cspOmit=workerBlob", BASE).href);
    await page.waitForFunction(() => !!window.__guardPolicyProbe, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__guardPolicyProbe.policyReady());
    // Chromium throws synchronously (csp-worker-blob); Firefox and WebKit fire
    // an opaque error event instead (worker-startup-error). Both name blob:.
    check(result.ok === false && ["csp-worker-blob", "worker-startup-error"].includes(result.code),
      `omitting blob: from worker-src fails the worker-create/channel stage (${JSON.stringify(result)})`);
    const blobText = `${result.hint ?? ""} ${result.detail ?? ""}`;
    check(/blob:/.test(blobText), `the message names blob: as the token to add (${blobText.slice(0, 400)})`);
    note(`worker-src without blob: reported as ${result.code}`);
    const violations = await page.evaluate(() => window.__cspViolations);
    note(`host securitypolicyviolation events for the refused blob: Worker: ${JSON.stringify(violations)}`);
    await page.close();
  }

  // --- 'wasm-unsafe-eval' removed: the blob: Worker inherits the host policy,
  //     so QuickJS cannot compile. Except on WebKit, which does not enforce
  //     CSP on Wasm compilation at all -- a documented claim limit, asserted
  //     here so the docs cannot drift away from it.
  {
    const sink = { requests: [], console: [] };
    const page = await browser.newPage();
    instrument(page, sink);
    await page.goto(new URL("/?cspOmit=wasmEval", BASE).href);
    await page.waitForFunction(
      () => /interactive|stopped|rejected|failed/.test(document.getElementById("status").textContent),
      null, { timeout: 60000 },
    );
    await page.waitForFunction(() => !!window.__guardPolicyProbe, null, { timeout: 30000 });
    const report = await page.textContent("#report");
    const log = await page.evaluate(() => window.__guardPolicyProbe.startupLog());
    // Observed on ALL THREE engines, including WebKit: the production QuickJS
    // path uses WebAssembly.instantiate, and that form is refused without
    // 'wasm-unsafe-eval' everywhere. This is narrower than the spike's N5,
    // which said WebKit 26 does not enforce CSP on Wasm compilation at all.
    // The engine-level detail is measured just below.
    check(/csp-wasm-unsafe-eval/.test(report) || log.some((l) => /csp-wasm-unsafe-eval/.test(l)),
      `omitting 'wasm-unsafe-eval' yields csp-wasm-unsafe-eval (report: ${report.slice(0, 300)})`);
    check(/wasm-unsafe-eval/.test(report) && !/'unsafe-eval'(?! is not)/.test(report.replace(/Do NOT use 'unsafe-eval'[^.]*\./g, "")),
      "the remedy offered is 'wasm-unsafe-eval', never 'unsafe-eval'");
    // Which Wasm entry points each engine actually gates. WebKit 26 does not
    // gate new WebAssembly.Module() or WebAssembly.compile(), and Firefox 141
    // does not gate either of them in the document realm -- but all three
    // gate WebAssembly.instantiate(), which is the one that matters here.
    const wasm = await page.evaluate(() => window.__guardPolicyProbe.wasmProbe());
    const brief = (v) => (String(v).startsWith("refused") ? "refused" : String(v));
    note(`without 'wasm-unsafe-eval': host sync=${brief(wasm.host.sync)} compile=${brief(wasm.host.async)} instantiate=${brief(wasm.host.instantiate)}; `
      + `blob: worker sync=${brief(wasm.blobWorker.wasmSync)} compile=${brief(wasm.blobWorker.wasmAsync)} instantiate=${brief(wasm.blobWorker.wasmInstantiate)}`);
    check(String(wasm.blobWorker.wasmInstantiate).startsWith("refused"),
      `WebAssembly.instantiate inside the blob: Worker is refused without 'wasm-unsafe-eval' (${brief(wasm.blobWorker.wasmInstantiate)})`);
    if (engine === "webkit") {
      check(wasm.blobWorker.wasmSync === "ok",
        "WebKit: new WebAssembly.Module() is NOT gated by CSP, so no claim of the form \"the policy prevents Wasm compilation\" holds there");
    }
    await page.close();
  }

  // --- the CDN origin removed from script-src: the cross-origin import is
  //     refused with effectiveDirective script-src-elem.
  {
    const sink = { requests: [], console: [] };
    const page = await browser.newPage();
    instrument(page, sink);
    await page.addInitScript(VIOLATION_PROBE);
    const url = new URL("/demo/cdn.html", BASE);
    url.searchParams.set("cdn", CDN_ORIGIN);
    url.searchParams.set("cspOmit", "cdnScript");
    await page.goto(url.href);
    await page.waitForFunction(() => window.__guardCdnProbe && window.__guardCdnProbe.done(), null, { timeout: 30000 });
    const stages = await page.evaluate(() => window.__guardCdnProbe.stages());
    const imported = stages.find((s) => s.name === "cdn-import");
    check(imported && imported.ok === false,
      `omitting the CDN origin from script-src blocks the cross-origin import (${JSON.stringify(stages)})`);
    const violations = await page.evaluate(() => window.__cspViolations);
    note(`host securitypolicyviolation events for the refused CDN import: ${JSON.stringify(violations)}`);
    check(violations.some((v) => /script-src/.test(v.directive)),
      `the refused CDN import is reported against a script-src directive (${JSON.stringify(violations)})`);
    await page.close();
  }
}

// ---------------------------------------------------------------------------

console.log(`demo: ${BASE}\ncdn:  ${CDN_ORIGIN}\nengines: ${selected.join(", ")}`);
for (const name of selected) await runEngine(name);

engineLabel = "";
console.log("\n--- notes");
for (const n of notes) console.log(n);
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`\nall browser checks passed on: ${selected.join(", ")}`);
