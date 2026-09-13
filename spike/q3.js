// End-to-end topology check. ?mode=blob|shim selects how the cross-origin CDN
// module creates its Workers.
import { FRAME_DOC, CDN } from "/frame-doc.js";

const mode = new URL(location.href).searchParams.get("mode") || "blob";
const R = { question: "q3", mode, cdn: CDN, violations: [], steps: {} };
document.addEventListener("securitypolicyviolation", (e) => {
  R.violations.push({
    effectiveDirective: e.effectiveDirective || e.violatedDirective,
    blockedURI: String(e.blockedURI).slice(0, 140)
  });
});
try {
  let guard = null;
  try {
    guard = await import(`${CDN}/cdn-guard.js`);
    R.steps.cdnGuardImport = { ok: true, url: guard.guardModuleUrl };
  } catch (e) {
    R.steps.cdnGuardImport = { ok: false, error: `${e.name}: ${String(e.message).slice(0, 200)}` };
  }
  if (guard) {
    R.steps.e2e = await guard.createGuard({
      frameDoc: FRAME_DOC, container: document.getElementById("host"), mode, cdn: CDN
    });
  }
} catch (e) {
  R.fatal = `${e.name}: ${String(e.message).slice(0, 300)}`;
}
document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__result = R;
window.__done = true;
