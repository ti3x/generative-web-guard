// Compact cross-engine matrix of the facts quoted in the report.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const E = ["chromium", "firefox", "webkit"].map((n) => JSON.parse(readFileSync(join(here, "results", `${n}.json`), "utf8")));
const tag = (v) => {
  if (v == null) return "-";
  const s = String(v);
  if (s === "ok" || s === "2" || /^status 200$/.test(s)) return "ok";
  if (/CompileError|EvalError|Refused|SecurityError|TypeError|NetworkError|blocked|denied|not allowed|CSP/i.test(s)) return "BLOCKED";
  return s.slice(0, 24);
};
const CASES = ["classic-abs-same-origin", "module-abs-same-origin", "classic-cross-origin-url",
  "module-cross-origin-url", "blob-inline-source", "blob-importscripts-cdn", "blob-module-dynamic-import-cdn", "blob-module-static-import-cdn",
  "shim-module-import-cdn", "data-url-worker", "worker-own-csp-strict", "worker-own-csp-no-wasm",
  "worker-own-csp-wasm", "shim-own-csp-wasm"];
const FIELDS = ["wasmSync", "wasmAsync", "newFunction", "evalResult", "fetchCdnWasm", "compileStreamingCdn", "nestedBlobWorker"];

for (const csp of Object.keys(E[0].q2)) {
  console.log(`\n### csp variant: ${csp}`);
  console.log(`page wasm/newFunction: ` + E.map((e) => {
    const p = ((e.q2[csp].result || {}).steps || {}).pageCapabilities || {};
    return `${e.engine}=${tag(p.wasmSync)}/${tag(p.wasmAsync)}/${tag(p.newFunction)}`;
  }).join("  "));
  console.log(`cdn module import: ` + E.map((e) => {
    const i = ((e.q2[csp].result || {}).steps || {}).cdnModuleImport || {};
    return `${e.engine}=${i.ok ? "ok" : "BLOCKED"}`;
  }).join("  "));
  for (const c of CASES) {
    const cells = E.map((e) => {
      const v = (((e.q2[csp].result || {}).steps || {}).cdnDrivenCases || {})[c];
      if (!v) return `${e.engine}=absent`;
      if (!v.gotResult) return `${e.engine}=NO-WORKER(${v.create === "ok" ? v.outcome : v.create.slice(0, 34)})`;
      const p = v.probe || {};
      return `${e.engine}=` + FIELDS.map((f) => tag(p[f])).join(",");
    });
    console.log(`  ${c.padEnd(28)} ${cells.join("  |  ")}`);
  }
}
console.log(`\nfields order: ${FIELDS.join(",")}`);
