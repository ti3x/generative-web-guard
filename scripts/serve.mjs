// Minimal static server for the demo. Serves the repo root with correct MIME
// types and a page-level CSP for the host document.
import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8080);

function frameHashes() {
  try {
    const m = JSON.parse(readFileSync(join(rootDir, "dist/frame-manifest.json"), "utf8"));
    return { scriptHash: m.scriptHash, cssHash: m.cssHash };
  } catch {
    return { scriptHash: "", cssHash: "" };
  }
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

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/demo/index.html";
  const file = normalize(join(rootDir, path));
  if (!file.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end("not found"); }
  if (!st.isFile()) { res.writeHead(404); return res.end("not found"); }
  const headers = {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (extname(file) === ".html") {
    // Host page policy. A srcdoc frame INHERITS the embedding page's CSP and
    // then adds its own, so the host policy must allow the frame's inline
    // script and stylesheet by hash. Everything else stays denied.
    const { scriptHash, cssHash } = frameHashes();
    headers["Content-Security-Policy"] =
      `default-src 'self'; script-src 'self' 'sha256-${scriptHash}'; style-src 'self' 'sha256-${cssHash}'; ` +
      "worker-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'";
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`demo: http://localhost:${port}/`));
