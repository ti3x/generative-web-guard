// Spike static server. Two origins:
//   HOST: http://localhost:8094  - the embedding application origin. HTML
//         responses get a Content-Security-Policy header supplied by the test
//         driver as base64 in ?csp64=, so one set of pages can be probed under
//         many policies without editing files.
//   CDN:  http://127.0.0.1:8095  - a different origin that serves the same
//         directory with Access-Control-Allow-Origin: *, standing in for a
//         cross-origin CDN-hosted library.
//
// Placeholders substituted in both HTML bodies and the CSP header:
//   {SCRIPT_HASH} sha256 of spike/frame-inline.js (the frame's inline script)
//   {CSS_HASH}    sha256 of spike/frame-inline.css
//   {CDN}         the CDN origin
//
// Generated routes (not files on disk):
//   /frame-doc.js  module exporting the srcdoc frame document + hashes
//   /probe-src.js  module exporting worker-probe.js source as a string
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const HOST_PORT = Number(process.env.HOST_PORT || 8094);
const CDN_PORT = Number(process.env.CDN_PORT || 8095);
const CDN = `http://127.0.0.1:${CDN_PORT}`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("base64");

function read(rel) {
  return readFileSync(join(root, rel));
}

function hashes() {
  return {
    SCRIPT_HASH: sha256(read("frame-inline.js")),
    CSS_HASH: sha256(read("frame-inline.css")),
    CDN,
  };
}

function subst(text, h) {
  return text
    .replaceAll("{SCRIPT_HASH}", h.SCRIPT_HASH)
    .replaceAll("{CSS_HASH}", h.CSS_HASH)
    .replaceAll("{CDN}", h.CDN);
}

// The frame document: opaque-origin sandbox="allow-scripts" srcdoc with its own
// meta CSP, mirroring src/host.js buildFrameDocument().
function frameDocModule(h) {
  const script = read("frame-inline.js").toString("utf8");
  const css = read("frame-inline.css").toString("utf8");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${h.SCRIPT_HASH}'`,
    `style-src 'sha256-${h.CSS_HASH}'`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const doc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${css}</style></head><body><div id="root"></div>` +
    `<script>${script}</script></body></html>`;
  return (
    `export const SCRIPT_HASH = ${JSON.stringify(h.SCRIPT_HASH)};\n` +
    `export const CSS_HASH = ${JSON.stringify(h.CSS_HASH)};\n` +
    `export const FRAME_CSP = ${JSON.stringify(csp)};\n` +
    `export const FRAME_DOC = ${JSON.stringify(doc)};\n` +
    `export const CDN = ${JSON.stringify(CDN)};\n`
  );
}

function probeSrcModule() {
  return `export const PROBE_SRC = ${JSON.stringify(read("worker-probe.js").toString("utf8"))};\nexport const CDN = ${JSON.stringify(CDN)};\n`;
}

function handler(isCdn) {
  return (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const h = hashes();
    const send = (body, type, extra = {}) => {
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(isCdn ? { "Access-Control-Allow-Origin": "*" } : {}),
        ...extra,
      });
      res.end(body);
    };

    if (path === "/frame-doc.js") return send(frameDocModule(h), types[".js"]);
    if (path === "/probe-src.js") return send(probeSrcModule(), types[".js"]);

    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404); return res.end("not found"); }
    if (!st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const ext = extname(file);
    const type = types[ext] || "application/octet-stream";
    const extra = {};
    if (ext === ".html" && !isCdn) {
      const raw = url.searchParams.get("csp64");
      if (raw) {
        const csp = subst(Buffer.from(raw, "base64url").toString("utf8"), h);
        if (csp.trim()) extra["Content-Security-Policy"] = csp;
      }
    }
    // ?wcsp64= puts a Content-Security-Policy on a *worker script* response.
    // Per CSP3 a Worker's policy comes from its own response, not from the
    // creating document, so this is how a worker can be constrained at all.
    const wraw = url.searchParams.get("wcsp64");
    if (wraw && ext === ".js") {
      const csp = subst(Buffer.from(wraw, "base64url").toString("utf8"), h);
      if (csp.trim()) extra["Content-Security-Policy"] = csp;
    }
    // Only HTML bodies are templated; .js is served verbatim so template
    // literals like ${CDN} are not mangled.
    const body = ext === ".html" ? subst(readFileSync(file, "utf8"), h) : readFileSync(file);
    send(body, type, extra);
  };
}

createServer(handler(false)).listen(HOST_PORT, () => console.log(`host: http://localhost:${HOST_PORT}/`));
createServer(handler(true)).listen(CDN_PORT, () => console.log(`cdn:  ${CDN}/`));
