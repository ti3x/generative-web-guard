// Spike policy Worker. Owns one end of the MessageChannel whose other end was
// transferred into the opaque-origin frame. The host never touches this port,
// so a render can only originate here. Classic worker so the same file works
// under `new Worker(url)` without module support questions.
var port = null;
var pending = Object.create(null);

function onPort(e) {
  var msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "frame-ready") {
    self.postMessage({ type: "frame-ready-seen", origin: msg.origin });
    return;
  }
  if (msg.type === "committed" || msg.type === "stale" || msg.type === "render-failed") {
    var key = String(msg.requestId);
    var job = pending[key];
    delete pending[key];
    self.postMessage({
      type: "render-settled",
      requestId: msg.requestId,
      outcome: msg.type,
      generation: msg.generation,
      nodeCount: msg.nodeCount,
      domText: msg.domText,
      matched: !!job && job.generation === msg.generation,
      ms: job ? Math.round(Date.now() - job.t0) : null
    });
    return;
  }
  if (msg.type === "stats") {
    self.postMessage({ type: "frame-stats", stats: msg.stats });
    return;
  }
  // Anything else (including the frame reporting a refused parent message) is
  // surfaced verbatim as evidence.
  self.postMessage({ type: "port-observed", data: msg });
}

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "install-port") {
    if (port) { self.postMessage({ type: "install-refused", reason: "already-installed" }); return; }
    port = e.ports[0];
    port.onmessage = onPort;
    if (port.start) port.start();
    self.postMessage({ type: "port-installed", hasPort: !!port });
    return;
  }
  if (msg.type === "render") {
    if (!port) { self.postMessage({ type: "render-settled", requestId: msg.requestId, outcome: "no-port" }); return; }
    pending[String(msg.requestId)] = { generation: msg.generation, t0: Date.now() };
    // The accepted tree travels directly from here to the frame.
    port.postMessage({
      type: "render",
      v: 1,
      requestId: msg.requestId,
      generation: msg.generation,
      nodes: [{ tag: "p", text: msg.text }]
    });
    return;
  }
  if (msg.type === "get-stats") {
    if (!port) { self.postMessage({ type: "frame-stats", error: "no-port" }); return; }
    port.postMessage({ type: "stats", v: 1 });
    return;
  }
  if (msg.type === "probe-wasm") {
    var bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    var out = { type: "wasm-probe" };
    try { new WebAssembly.Module(bytes); out.wasmSync = "ok"; }
    catch (err) { out.wasmSync = err.name + ": " + String(err.message).slice(0, 160); }
    WebAssembly.compile(bytes).then(function () { out.wasmAsync = "ok"; }, function (err) {
      out.wasmAsync = err.name + ": " + String(err.message).slice(0, 160);
    }).then(function () { self.postMessage(out); });
    return;
  }
};
