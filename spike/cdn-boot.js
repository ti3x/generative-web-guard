// Stands in for the cross-origin CDN-distributed library entry point. Served
// from the CDN origin, imported dynamically by the host page. It creates the
// Workers, so any CSP failure here is what a real CDN consumer would hit.
export { runCases, caseList } from "./worker-cases.js";
export const bootModuleUrl = import.meta.url;

export async function probeHere() {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const out = { where: "cdn-module-on-host-document", moduleUrl: import.meta.url };
  const err = (e) => `${e.name}: ${String(e.message).slice(0, 140)}`;
  try { new WebAssembly.Module(bytes); out.wasmSync = "ok"; } catch (e) { out.wasmSync = err(e); }
  try { await WebAssembly.compile(bytes); out.wasmAsync = "ok"; } catch (e) { out.wasmAsync = err(e); }
  return out;
}
