// Demo server. Two origins and one Content-Security-Policy profile.
//
//   host:  http://localhost:<PORT>        serves the repo, sends the host CSP
//   "cdn": http://127.0.0.1:<PORT+1>      serves cdn/ only, with CORS
//
// The second origin exists so the cross-origin CDN path can actually be
// tested: a different host and the same port is still a different origin, and
// the whole point of the blob: Worker payload is that it works when the
// library itself came from somewhere else.
//
// HOST POLICY: Profile A from spike/policy-worker-feasibility.md, verified end
// to end on Chromium, Firefox and WebKit. Read docs/csp.md before changing a
// token here. In particular:
//
//   * `default-src 'none'` -- everything is denied unless listed.
//   * `script-src 'self' <cdn> 'wasm-unsafe-eval' 'sha256-<frameScript>'`
//     'self' for the demo's own modules; <cdn> so the host page can import the
//     cross-origin bundle; 'wasm-unsafe-eval' because a blob: Worker inherits
//     THIS policy and QuickJS compiles Wasm inside it; the hash because the
//     srcdoc frame also inherits this policy and its inline script is pinned.
//     'wasm-unsafe-eval' is not 'unsafe-eval': eval and new Function stay
//     blocked, confirmed on all three engines.
//   * `style-src 'self' 'sha256-<frameStyle>'` -- same inheritance reason for
//     the frame's inline stylesheet.
//   * `worker-src 'self' blob:` -- blob: is required for the Worker payloads.
//     child-src or default-src could carry blob: instead, but whichever
//     directive applies must contain it; omitting worker-src does not make
//     blob: Workers free.
//   * `connect-src 'none'` -- Profile A quotes `connect-src <cdn>` and
//     justifies it as "only if a .wasm or other asset is fetched at runtime".
//     The bundled QuickJS variant embeds its binary and the demo fetches
//     nothing, so the demo takes the tighter option. A build that ships a
//     separate .wasm has to widen this.
//   * NO `frame-src`. It is not enforced for a srcdoc frame on any engine:
//     with `frame-src 'none'` the frame still loaded, bootstrapped and
//     rendered on Chromium, Firefox and WebKit. The previous
//     `frame-src 'self' about:` was inert and is removed rather than left in
//     place looking like a control.
//   * No 'unsafe-eval', no 'unsafe-inline'. The frame keeps
//     sandbox="allow-scripts" with no allow-same-origin (src/host.js).
//
// TEST HOOK: `?cspOmit=<name>[,<name>]` drops one required token from the host
// policy so the startup-error path for that misconfiguration can be exercised
// in a real browser (scripts/browser-check.mjs). It only ever REMOVES a token,
// never adds one, and it is a demo-server affordance, not a library feature.
import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8080);
const cdnPort = Number(process.env.CDN_PORT || port + 1);
const cdnHost = process.env.CDN_HOST || "127.0.0.1";
const cdnOrigin = `http://${cdnHost}:${cdnPort}`;

function frameHashes() {
  try {
    const m = JSON.parse(readFileSync(join(rootDir, "dist/frame-manifest.json"), "utf8"));
    return { scriptHash: m.scriptHash, cssHash: m.cssHash };
  } catch {
    return { scriptHash: "", cssHash: "" };
  }
}

// Exactly Profile A. `omit` is the test hook; with no omissions this is the
// policy the README and docs/csp.md quote.
export function hostCsp({ scriptHash, cssHash, cdn = cdnOrigin, omit = new Set() }) {
  const scriptSrc = ["'self'"];
  if (!omit.has("cdnScript")) scriptSrc.push(cdn);
  if (!omit.has("wasmEval")) scriptSrc.push("'wasm-unsafe-eval'");
  if (!omit.has("frameScriptHash")) scriptSrc.push(`'sha256-${scriptHash}'`);
  const styleSrc = ["'self'"];
  if (!omit.has("frameStyleHash")) styleSrc.push(`'sha256-${cssHash}'`);
  const workerSrc = ["'self'"];
  if (!omit.has("workerBlob")) workerSrc.push("blob:");
  return [
    "default-src 'none'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    `worker-src ${workerSrc.join(" ")}`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function serveFile(file, res, extra = {}) {
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end("not found"); }
  if (!st.isFile()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extra,
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/demo/index.html";
  const file = normalize(join(rootDir, path));
  if (!file.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
  const extra = {};
  if (extname(file) === ".html") {
    const omit = new Set((url.searchParams.get("cspOmit") || "").split(",").filter(Boolean));
    extra["Content-Security-Policy"] = hostCsp({ ...frameHashes(), omit });
  }
  serveFile(file, res, extra);
}).listen(port, () => console.log(`demo: http://localhost:${port}/`));

// The "CDN": a second origin that serves the committed bundles only. No CSP
// header of its own, so a Worker created from one of its scripts by URL would
// be uncontained -- which is precisely why the library never does that and
// ships the payload inside the module instead.
createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = normalize(join(rootDir, "cdn", path));
  if (!file.startsWith(join(rootDir, "cdn"))) { res.writeHead(403); return res.end(); }
  serveFile(file, res, { "Access-Control-Allow-Origin": "*" });
}).listen(cdnPort, cdnHost, () => console.log(`cdn:  ${cdnOrigin}/`));
