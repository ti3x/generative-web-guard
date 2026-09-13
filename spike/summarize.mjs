// Renders spike/results/*.json into the tables used by the report.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "results");
const engines = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

const short = (s) => (s == null ? "-" : String(s).replace(/\s+/g, " ").slice(0, 60));

console.log("# engines");
for (const e of engines) console.log(` ${e.engine} ${e.version}`);

console.log("\n# q1: frame bootstrap (driver-observed frame state)");
for (const e of engines) {
  for (const [csp, rec] of Object.entries(e.q1)) {
    const f = rec.frameSeenByDriver || {};
    const st = f.stats || {};
    const s = rec.result && rec.result.steps || {};
    console.log([
      e.engine, csp,
      `origin=${f.origin}`,
      `root="${short(f.rootText)}"`,
      `bootAccepted=${st.bootstrapAccepted}`,
      `bootRejected=${st.bootstrapRejected}`,
      `parentAfter=${st.parentMessagesAfterBootstrap}`,
      `parentRenderAttempts=${st.parentRenderAttemptsAfterBootstrap}`,
      `portRenders=${st.portRenders}`,
      `stale=${st.portStale}`,
      `acks=${st.acks}`,
      `r1=${s.render1 ? s.render1.outcome || JSON.stringify(s.render1) : "-"}`,
      `r2=${s.render2 ? s.render2.outcome || JSON.stringify(s.render2) : "-"}`,
      `staleOutcome=${s.renderStale ? s.renderStale.outcome || JSON.stringify(s.renderStale) : "-"}`,
      `workerWasm=${s.workerWasm ? s.workerWasm.wasmSync + "/" + s.workerWasm.wasmAsync : "-"}`,
      `violations=${(rec.result && rec.result.violations || []).map((v) => v.effectiveDirective).join("|") || "none"}`,
    ].join("  "));
  }
  console.log("");
}

console.log("\n# q1: ack timings and details (demo-current)");
for (const e of engines) {
  const s = (e.q1["demo-current"].result || {}).steps || {};
  console.log(` ${e.engine}: portInstalled=${JSON.stringify(s.portInstalled)} frameReady=${JSON.stringify(s.frameReadySeen)}`);
  console.log(`   render1=${JSON.stringify(s.render1)}`);
  console.log(`   render2=${JSON.stringify(s.render2)}`);
  console.log(`   stale=${JSON.stringify(s.renderStale)}`);
  console.log(`   refusalsOverPort=${JSON.stringify(s.frameRefusalsSeenOverPort)}`);
  console.log(`   secondBootstrap=${JSON.stringify(s.secondBootstrap)}`);
  console.log(`   finalFrameStats=${JSON.stringify(s.finalFrameStats)}`);
}

const CASES = ["classic-abs-same-origin", "classic-relative-to-document", "module-abs-same-origin",
  "classic-cross-origin-url", "module-cross-origin-url", "blob-inline-source", "blob-importscripts-cdn",
  "blob-module-dynamic-import-cdn", "blob-module-static-import-cdn", "shim-module-import-cdn", "data-url-worker", "worker-own-csp-strict", "worker-own-csp-no-wasm",
  "worker-own-csp-wasm", "shim-own-csp-wasm"];

console.log("\n# q2: worker creation by CDN module (ok / blocked reason)");
for (const e of engines) {
  console.log(`\n## ${e.engine}`);
  for (const [csp, rec] of Object.entries(e.q2)) {
    const r = rec.result || {};
    const st = r.steps || {};
    console.log(` [${csp}] cdnImport=${st.cdnModuleImport ? st.cdnModuleImport.ok : "?"} ${st.cdnModuleImport && st.cdnModuleImport.error ? short(st.cdnModuleImport.error) : ""}`);
    console.log(`   page: wasmSync=${(st.pageCapabilities||{}).wasmSync} wasmAsync=${(st.pageCapabilities||{}).wasmAsync} newFunction=${short((st.pageCapabilities||{}).newFunction)}`);
    const cases = st.cdnDrivenCases || {};
    for (const c of CASES) {
      const v = cases[c];
      if (!v) continue;
      const p = v.probe || {};
      console.log(`   ${c.padEnd(30)} ${v.gotResult ? "OK " : "BLK"} create=${short(v.create)} outcome=${v.outcome} err=${short(v.errors.join("|"))}` +
        (v.gotResult ? ` | wasmSync=${short(p.wasmSync)} wasmAsync=${short(p.wasmAsync)} newFn=${short(p.newFunction)} eval=${short(p.evalResult)} fetchCdn=${short(p.fetchCdnWasm)} stream=${short(p.compileStreamingCdn)} nested=${short(p.nestedBlobWorker)} shimFail=${short(p.shimImportFailed)}` : ""));
    }
    const v = r.violations || [];
    console.log(`   violations: ${v.map((x) => `${x.effectiveDirective}<-${short(x.blockedURI)}`).join(" ; ") || "none"}`);
  }
}
