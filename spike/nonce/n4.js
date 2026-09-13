// Host bootstrap module for n4: the whole documented topology under a nonce
// policy. A nonce'd host module dynamically imports the cross-origin library,
// and that cross-origin module creates the blob: policy Worker, the opaque
// frame, the private port, compiles Wasm, and commits one acknowledged render.
const CDN = "{CDN}";
const FRAME_DOC = {FRAME_DOC_JSON};
const R = window.__result;
R.steps.bootstrapNeverRan = false;
R.steps.hostModuleRan = true;

let guard = null;
try {
  guard = await import(CDN + "/cdn-guard-n.js");
  R.steps.cdnGuardImport = { ok: true, url: guard.guardModuleUrl };
} catch (e) {
  R.steps.cdnGuardImport = { ok: false, error: e.name + ": " + String(e.message).slice(0, 200) };
}
if (guard) {
  try {
    R.steps.e2e = await guard.createGuard({ frameDoc: FRAME_DOC, container: document.getElementById("host") });
  } catch (e) {
    R.steps.e2e = { fatal: e.name + ": " + String(e.message).slice(0, 200) };
  }
}
document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__done = true;
