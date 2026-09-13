// Worker-creation matrix. This module is served from BOTH origins: q2.js
// imports the host-origin copy as a control, and the cross-origin CDN copy is
// imported dynamically so the cases run from code whose module URL is the CDN.
import { PROBE_SRC, CDN } from "./probe-src.js";

const TIMEOUT = 1400;

function tryWorker(make) {
  return new Promise((resolve) => {
    const out = { create: "ok", gotResult: false, errors: [], messages: 0 };
    let w;
    try { w = make(); } catch (e) { out.create = `throw ${e.name}: ${String(e.message).slice(0, 160)}`; return resolve(out); }
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      out.outcome = why;
      try { w.terminate(); } catch (e) {}
      resolve(out);
    };
    const timer = setTimeout(() => done("timeout"), TIMEOUT);
    w.onerror = (e) => {
      out.errors.push(String(e.message || e.type || "error").slice(0, 200));
      // A failed worker script load reports here; stop waiting for the probe.
      setTimeout(() => done("error"), 150);
    };
    w.onmessageerror = () => out.errors.push("messageerror");
    w.onmessage = (e) => {
      out.messages++;
      const d = e.data;
      if (d && d.type === "probe-result") {
        out.gotResult = true;
        out.probe = d;
        clearTimeout(timer);
        done("probe-result");
      }
    };
  });
}

// Base64url, so a worker-script CSP can travel in the query string.
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A worker script response can carry its own CSP. {CDN} is substituted server
// side. These are the policies quoted in the report as "worker response CSP".
export const WORKER_CSP_STRICT = "default-src 'none'; script-src 'none'; connect-src 'none'";
export const WORKER_CSP_NO_WASM = "default-src 'none'; script-src 'self' {CDN}; connect-src {CDN}";
export const WORKER_CSP_WASM = "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval'; connect-src {CDN}";

function blobUrl(src) {
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

export function caseList(cdn = CDN) {
  return [
    ["classic-abs-same-origin", () => new Worker("/worker-probe.js", { name: cdn })],
    ["classic-relative-to-document", () => new Worker("./worker-probe.js", { name: cdn })],
    ["module-abs-same-origin", () => new Worker("/worker-probe.js", { type: "module", name: cdn })],
    ["classic-cross-origin-url", () => new Worker(cdn + "/worker-probe.js", { name: cdn })],
    ["module-cross-origin-url", () => new Worker(cdn + "/worker-probe.js", { type: "module", name: cdn })],
    ["blob-inline-source", () => new Worker(blobUrl(PROBE_SRC), { name: cdn })],
    ["blob-importscripts-cdn", () => new Worker(blobUrl(`importScripts(${JSON.stringify(cdn + "/worker-probe.js")});`), { name: cdn })],
    ["blob-module-dynamic-import-cdn", () => new Worker(blobUrl(`await import(${JSON.stringify(cdn + "/worker-probe.js")});`), { type: "module", name: cdn })],
    ["blob-module-static-import-cdn", () => new Worker(blobUrl(`import ${JSON.stringify(cdn + "/worker-probe.js")};`), { type: "module", name: cdn })],
    ["shim-module-import-cdn", () => new Worker("/shim-worker.js", { type: "module", name: cdn })],
    ["data-url-worker", () => new Worker("data:text/javascript," + encodeURIComponent(PROBE_SRC), { name: cdn })],
    ["worker-own-csp-strict", () => new Worker(`/worker-probe.js?wcsp64=${b64url(WORKER_CSP_STRICT)}`, { name: cdn })],
    ["worker-own-csp-no-wasm", () => new Worker(`/worker-probe.js?wcsp64=${b64url(WORKER_CSP_NO_WASM)}`, { name: cdn })],
    ["worker-own-csp-wasm", () => new Worker(`/worker-probe.js?wcsp64=${b64url(WORKER_CSP_WASM)}`, { name: cdn })],
    ["shim-own-csp-wasm", () => new Worker(`/shim-worker.js?wcsp64=${b64url(WORKER_CSP_WASM)}`, { type: "module", name: cdn })],
  ];
}

export async function runCases({ only, cdn = CDN } = {}) {
  const results = {};
  results.__moduleUrl = import.meta.url;
  for (const [name, make] of caseList(cdn)) {
    if (only && !only.includes(name)) continue;
    results[name] = await tryWorker(make);
  }
  return results;
}
