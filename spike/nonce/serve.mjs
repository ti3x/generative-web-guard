// Spike server for the nonce / 'strict-dynamic' feasibility spike.
// Independent copy of spike/serve.mjs (that file is committed evidence and is
// not modified). Two origins:
//   HOST: http://localhost:8098  - the embedding application origin. HTML and
//         a small allowlist of host .js files are templated, and the
//         Content-Security-Policy header comes from ?csp64= (base64url).
//   CDN:  http://127.0.0.1:8099  - a different origin, Access-Control-Allow-Origin: *.
//
// NONCE HANDLING. A real deployment mints a fresh nonce per response and
// templates it into both the header and the markup. Here the DRIVER supplies
// it as ?nonce=<value> so that one page load and every subresource request it
// makes agree on the same value; the provenance of the value is irrelevant to
// what is being measured (whether the header and the attribute match, and
// whether the resulting policy permits a given load).
//
// Placeholders substituted in the CSP header, in HTML bodies and in the
// templated host .js files:
//   {SCRIPT_HASH}      sha256 of frame-inline.js
//   {CSS_HASH}         sha256 of frame-inline.css
//   {CDN}              the CDN origin
//   {NONCE}            the nonce value for this page load
//   {NONCE_ATTR_HOST}  nonce="..." for the host's own bootstrap script, or ""
//                      (?hostNonce=0 removes it)
//   {NONCE_ATTR_CDN}   nonce="..." for a parser-inserted CDN script tag, or ""
//   {FRAME_DOC_JSON}   JSON string of the hash-pinned srcdoc frame document
//   {FRAME_CSP}        the frame's own meta policy
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const HOST_PORT = Number(process.env.HOST_PORT || 8098);
const CDN_PORT = Number(process.env.CDN_PORT || 8099);
const CDN = `http://127.0.0.1:${CDN_PORT}`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

// Host-origin .js files that get placeholder substitution. Everything else is
// served verbatim, so CDN payloads and worker sources keep their exact bytes.
const TEMPLATED_JS = new Set(["/collector.js", "/n1.js", "/n2.js", "/n3.js", "/n4.js"]);
// CDN-origin files that also need {CDN} / {NONCE} substitution. None of them
// contain a `${...}` template literal, so a plain replace is safe.
const CDN_TEMPLATED_JS = new Set(["/cdn-module-nonced.js", "/cdn-guard-n.js", "/worker-payload.js"]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("base64");
const read = (rel) => readFileSync(join(root, rel));

// The frame document, byte-identical in shape to src/host.js buildFrameDocument
// and to spike/serve.mjs's frameDocModule: opaque-origin sandbox="allow-scripts"
// srcdoc with its own meta CSP pinning the inline script and style by hash.
// `nonceAttr` is only used by the ?frameNonce=1 contingency probe.
function frameDoc(h, nonceAttr, includeHashInFrameCsp = true) {
  const csp = [
    "default-src 'none'",
    `script-src ${includeHashInFrameCsp ? `'sha256-${h.SCRIPT_HASH}'` : "'none'"}${nonceAttr ? ` 'nonce-${h.NONCE}'` : ""}`,
    `style-src 'sha256-${h.CSS_HASH}'`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const doc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${read("frame-inline.css").toString("utf8")}</style></head>` +
    `<body><div id="root"></div>` +
    `<script${nonceAttr ? ` nonce="${h.NONCE}"` : ""}>${read("frame-inline.js").toString("utf8")}</script>` +
    "</body></html>";
  return { csp, doc };
}

function handler(isCdn) {
  return (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";

    const nonce = url.searchParams.get("nonce") || randomBytes(16).toString("base64url");
    const hostNonce = url.searchParams.get("hostNonce") !== "0";
    const cdnNonce = url.searchParams.get("cdnNonce") !== "0";
    const frameNonce = url.searchParams.get("frameNonce") === "1";
    const h = {
      SCRIPT_HASH: sha256(read("frame-inline.js")),
      CSS_HASH: sha256(read("frame-inline.css")),
      CDN,
      NONCE: nonce,
    };
    const fd = frameDoc(h, frameNonce);
    const subst = (text) => text
      .replaceAll("{SCRIPT_HASH}", h.SCRIPT_HASH)
      .replaceAll("{CSS_HASH}", h.CSS_HASH)
      .replaceAll("{CDN}", h.CDN)
      .replaceAll("{NONCE_ATTR_HOST}", hostNonce ? `nonce="${nonce}"` : "")
      .replaceAll("{NONCE_ATTR_CDN}", cdnNonce ? `nonce="${nonce}"` : "")
      .replaceAll("{FRAME_DOC_JSON}", JSON.stringify(fd.doc))
      .replaceAll("{FRAME_CSP}", fd.csp)
      .replaceAll("{FRAME_NONCE}", frameNonce ? "1" : "0")
      .replaceAll("{POLICY_WORKER_SRC}", JSON.stringify(read("policy-worker.js").toString("utf8")))
      .replaceAll("{NONCE}", nonce);

    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404); return res.end("not found"); }
    if (!st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const ext = extname(file);
    const extra = {};
    if (ext === ".html" && !isCdn) {
      const raw = url.searchParams.get("csp64");
      if (raw) {
        const csp = subst(Buffer.from(raw, "base64url").toString("utf8"));
        if (csp.trim()) extra["Content-Security-Policy"] = csp;
      }
    }
    // ?wcsp64= puts a policy on a worker script response (a Worker's own
    // policy comes from its own response). Kept for parity with spike/serve.mjs.
    const wraw = url.searchParams.get("wcsp64");
    if (wraw && ext === ".js") {
      const csp = subst(Buffer.from(wraw, "base64url").toString("utf8"));
      if (csp.trim()) extra["Content-Security-Policy"] = csp;
    }
    const templated = ext === ".html"
      || (!isCdn && TEMPLATED_JS.has(path))
      || (isCdn && CDN_TEMPLATED_JS.has(path));
    const body = templated ? subst(readFileSync(file, "utf8")) : readFileSync(file);
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(isCdn ? { "Access-Control-Allow-Origin": "*" } : {}),
      ...extra,
    });
    res.end(body);
  };
}

createServer(handler(false)).listen(HOST_PORT, () => console.log(`host: http://localhost:${HOST_PORT}/`));
createServer(handler(true)).listen(CDN_PORT, () => console.log(`cdn:  ${CDN}/`));
