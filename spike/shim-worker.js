// Same-origin module worker whose only job is to import the cross-origin CDN
// worker payload. Tests whether a `worker-src 'self'` host can still run
// CDN-distributed worker code if the CDN origin is allowed in script-src.
const cdn = self.name || "";
try {
  await import(cdn + "/worker-probe.js");
} catch (e) {
  self.postMessage({ type: "probe-result", shimImportFailed: e.name + ": " + String(e.message).slice(0, 200), cdn });
}
