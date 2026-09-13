// Cross-engine matrix + question 7 evidence, read from results/*.json.
// Also runs the observed error strings through the REAL src/startup.js
// classifier (read-only import; that file belongs to another agent) so the
// report can state which startup code a consumer would actually get.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyStartupFailure, STARTUP_STAGES } from "../../src/startup.js";

const here = dirname(fileURLToPath(import.meta.url));
const engines = ["chromium", "firefox", "webkit"];
const R = {};
for (const e of engines) R[e] = JSON.parse(readFileSync(join(here, "results", `${e}.json`), "utf8"));

console.log("### versions");
for (const e of engines) console.log(`${e}: ${R[e].version} (revision ${R[e].revision}) @ ${R[e].when}`);

const TAGS = ["cdnTagNonced", "cdnTagPlain", "cdnModuleNonced", "cdnModulePlain", "hostTagPlain", "hostModulePlain", "cdnProgrammaticInsert", "cdnModuleNoncedChainImport"];
console.log("\n### n1: which script loads ran (ran / -)");
const n1keys = Object.keys(R.chromium.n1);
for (const k of n1keys) {
  console.log(`\n-- ${k}`);
  for (const e of engines) {
    const rec = R[e].n1[k] || {};
    const r = rec.result || {};
    const t = r.tags || {};
    const row = TAGS.map((tag) => `${tag}=${t[tag] ? "Y" : "-"}`).join(" ");
    const s = r.steps || {};
    console.log(`   ${e.padEnd(9)} hostModule=${s.hostModuleRan ? "Y" : "-"} ${row} dynImport=${s.dynamicImportFromHostModule ? (s.dynamicImportFromHostModule.ok ? "Y" : "N:" + s.dynamicImportFromHostModule.error) : "-"} insert=${s.programmaticInsert || "-"} insertModule=${s.programmaticInsertModule || "-"} eval=${s.evalResult || "-"}`);
  }
}

console.log("\n### n2: blob: Workers");
for (const k of Object.keys(R.chromium.n2)) {
  console.log(`\n-- ${k}`);
  for (const e of engines) {
    const rec = R[e].n2[k] || {};
    const s = (rec.result || {}).steps || {};
    const c = s.blobClassic || {};
    const m = s.blobModule || {};
    const p = c.probe || {};
    const v = ((rec.result || {}).violations || []).filter((x) => x.effectiveDirective !== "img-src");
    console.log(`   ${e.padEnd(9)} created=${c.created} topLevel=${c.topLevelRan ? "Y" : "-"} err=${c.errorEvent || "-"} wasmSync=${p.wasmSync || "-"} wasmInstantiate=${(p.wasmInstantiate || "-").slice(0, 40)} eval=${p.evalResult || "-"} newFunction=${p.newFunction || "-"} fetch=${p.fetchCdn || "-"} nested=${p.nestedBlobWorker || "-"} | module top=${m.topLevelRan ? "Y" : "-"} dynImport=${(m.probe && m.probe.dynamicImport || "-").slice(0, 60)} | violations=${JSON.stringify(v)}`);
  }
}

console.log("\n### n3: hash-pinned srcdoc frame");
for (const k of Object.keys(R.chromium.n3)) {
  console.log(`\n-- ${k}`);
  for (const e of engines) {
    const rec = R[e].n3[k] || {};
    const s = (rec.result || {}).steps || {};
    const f = rec.frameSeenByDriver || {};
    const v = ((rec.result || {}).violations || []).filter((x) => x.effectiveDirective !== "img-src");
    console.log(`   ${e.padEnd(9)} frameScriptRan=${f.scriptRan ? "Y" : "-"} origin=${f.origin} committed=${s.committed && !s.committed.timeout ? "Y" : "-"} font=${f.rootFont} root="${String(f.rootText || "").slice(0, 26)}" hostViolations=${JSON.stringify(v)} frameConsole="${((rec.consoleMsgs || []).find((m) => m.url === "about:srcdoc") || {}).text ? "yes" : "no"}"`);
  }
}

console.log("\n### n4: end to end");
for (const k of Object.keys(R.chromium.n4)) {
  console.log(`\n-- ${k}`);
  for (const e of engines) {
    const rec = R[e].n4[k] || {};
    const s = (rec.result || {}).steps || {};
    const st = (s.e2e || {}).steps || {};
    const f = rec.frameSeenByDriver || {};
    console.log(`   ${e.padEnd(9)} import=${s.cdnGuardImport && s.cdnGuardImport.ok} frameAlive=${st.frameAlive && !st.frameAlive.timeout ? "Y" : "-"} worker=${st.policyWorkerCreate} port=${st.portInstalled && st.portInstalled.type || JSON.stringify(st.portInstalled)} wasm=${st.policyWorkerWasm ? String(st.policyWorkerWasm.wasmSync).slice(0, 30) : "-"} render=${st.render ? (st.render.outcome || JSON.stringify(st.render)) : "-"} ms=${st.renderMs} frameRoot="${String(f.rootText || "").slice(0, 26)}" hostInjectRefused=${st.frameStats && st.frameStats.stats ? st.frameStats.stats.parentRenderAttemptsAfterBootstrap : "-"}`);
  }
}

console.log("\n### question 7: what code would src/startup.js report for each observed failure");
const cases = [];
for (const e of engines) {
  const w = ((R[e].n2["nonce-sd-worker-src-self-only"] || {}).result || {}).steps || {};
  const c = w.blobClassic || {};
  cases.push([e, "blob: Worker refused (worker-src 'self')", c.created === "ok" ? `async error event: ${c.errorEvent}` : c.created]);
  const nw = ((R[e].n2["nonce-sd-no-wasm-token"] || {}).result || {}).steps || {};
  cases.push([e, "wasm refused (no 'wasm-unsafe-eval')", (nw.blobClassic && nw.blobClassic.probe && nw.blobClassic.probe.wasmInstantiate) || "-"]);
  const ni = ((R[e].n2["nonce-only-worker-blob"] || {}).result || {}).steps || {};
  cases.push([e, "worker dynamic import refused (no 'strict-dynamic', no cdn)", (ni.blobModule && ni.blobModule.probe && ni.blobModule.probe.dynamicImport) || "-"]);
  const hm = ((R[e].n1["nonce-sd-with-cdn-and-self/no-host-nonce"] || {}).result || {}).steps || {};
  cases.push([e, "host bootstrap module refused (no nonce on the tag)", hm.hostModuleRan ? "RAN (not a failure on this engine)" : "no error object reachable: the module never ran"]);
  cases.push([e, "frame script refused (no hash in host policy)", "no error, no securitypolicyviolation: bootstrap timeout only"]);
}
for (const [e, label, text] of cases) {
  const code = /no error|never ran/.test(text) ? "(nothing to classify)" : classifyStartupFailure(STARTUP_STAGES.workerCreate, text, null);
  console.log(`${e.padEnd(9)} ${label.padEnd(60)} -> ${code}\n          observed: ${String(text).slice(0, 150)}`);
}
