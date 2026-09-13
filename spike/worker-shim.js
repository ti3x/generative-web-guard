// Same-origin module-worker shim. `name` is a JSON envelope {url, cdn}: the
// shim imports the cross-origin payload at `url`. This is the "same-origin
// shim" approach for hosts that will not put `blob:` in worker-src.
let envelope;
try { envelope = JSON.parse(self.name); } catch (e) { envelope = { url: self.name }; }
try {
  await import(envelope.url);
} catch (e) {
  self.postMessage({ type: "shim-import-failed", error: e.name + ": " + String(e.message).slice(0, 200), url: envelope.url });
}
