// Host side of spike questions 2, 3 and 4.
import { CDN } from "/probe-src.js";

const R = { question: "q2", cdn: CDN, violations: [], steps: {} };
const out = document.getElementById("out");
document.addEventListener("securitypolicyviolation", (e) => {
  R.violations.push({
    effectiveDirective: e.effectiveDirective || e.violatedDirective,
    blockedURI: String(e.blockedURI).slice(0, 140),
    sourceFile: String(e.sourceFile || "").slice(0, 140)
  });
});

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const err = (e) => `${e.name}: ${String(e.message).slice(0, 160)}`;

try {
  // Page-level Wasm, for comparison with the Worker result.
  const page = {};
  try { new WebAssembly.Module(bytes); page.wasmSync = "ok"; } catch (e) { page.wasmSync = err(e); }
  try { await WebAssembly.compile(bytes); page.wasmAsync = "ok"; } catch (e) { page.wasmAsync = err(e); }
  try { new Function("return 1"); page.newFunction = "ok"; } catch (e) { page.newFunction = err(e); }
  R.steps.pageCapabilities = page;

  // Control: cases driven by same-origin host code.
  const local = await import("/worker-cases.js");
  R.steps.hostDrivenControl = await local.runCases({
    only: ["classic-abs-same-origin", "blob-inline-source"]
  });

  // The real scenario: a cross-origin CDN module creates the Workers.
  let boot = null;
  try {
    boot = await import(`${CDN}/cdn-boot.js`);
    R.steps.cdnModuleImport = { ok: true, moduleUrl: boot.bootModuleUrl };
  } catch (e) {
    R.steps.cdnModuleImport = { ok: false, error: err(e) };
  }
  if (boot) {
    R.steps.cdnModuleCapabilities = await boot.probeHere();
    R.steps.cdnDrivenCases = await boot.runCases({});
  }
} catch (e) {
  R.fatal = err(e);
}

out.textContent = JSON.stringify(R, null, 1);
window.__result = R;
window.__done = true;
