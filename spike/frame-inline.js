// Runs INSIDE the opaque-origin sandbox="allow-scripts" frame under the frame's
// own meta CSP (default-src 'none', script hash, trusted-types 'none').
//
// Spike question 1 and 5: accept exactly one bootstrap postMessage from the
// parent carrying one MessagePort, then accept render commands ONLY over that
// port, refuse every later parent message, and acknowledge each commit over the
// port for the exact request/generation.
(function () {
  var parentWin = window.parent;
  var stats = {
    bootstrapAccepted: 0,
    bootstrapRejected: 0,
    portInstalled: false,
    parentMessagesAfterBootstrap: 0,
    parentRenderAttemptsAfterBootstrap: 0,
    parentMessagesBeforeBootstrap: 0,
    portRenders: 0,
    portStale: 0,
    acks: 0,
    lastGeneration: 0,
    lastRequestId: null,
    // Platform facts observed from inside the frame under its own policy.
    trustedTypesSupported: typeof window.trustedTypes !== "undefined",
    notes: []
  };
  window.__frameStats = stats;
  var port = null;

  function render(nodes) {
    var root = document.getElementById("root");
    while (root.firstChild) root.removeChild(root.firstChild);
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var spec = nodes[i];
      var el = document.createElement(spec.tag === "p" ? "p" : "span");
      el.textContent = String(spec.text == null ? "" : spec.text);
      root.appendChild(el);
      n++;
    }
    return n;
  }

  function onPortMessage(e) {
    var msg = e.data;
    if (!msg || typeof msg !== "object" || msg.v !== 1) {
      try { port.postMessage({ type: "refused", reason: "bad-envelope" }); } catch (err) {}
      return;
    }
    if (msg.type === "render") {
      if (typeof msg.generation !== "number" || msg.generation <= stats.lastGeneration) {
        stats.portStale++;
        port.postMessage({ type: "stale", v: 1, requestId: msg.requestId, generation: msg.generation });
        return;
      }
      var count;
      try {
        count = render(Array.isArray(msg.nodes) ? msg.nodes : []);
      } catch (err) {
        port.postMessage({ type: "render-failed", v: 1, requestId: msg.requestId, reason: String(err && err.name) });
        return;
      }
      stats.portRenders++;
      stats.lastGeneration = msg.generation;
      stats.lastRequestId = msg.requestId;
      stats.acks++;
      // Commit acknowledgement for the exact request/generation.
      port.postMessage({
        type: "committed",
        v: 1,
        requestId: msg.requestId,
        generation: msg.generation,
        nodeCount: count,
        domText: document.getElementById("root").textContent
      });
      return;
    }
    if (msg.type === "stats") {
      port.postMessage({ type: "stats", v: 1, stats: JSON.parse(JSON.stringify(stats)) });
      return;
    }
    port.postMessage({ type: "refused", v: 1, reason: "unknown-type" });
  }

  window.addEventListener("message", function (e) {
    // Only the parent may bootstrap; anything else is ignored outright.
    if (e.source !== parentWin) { stats.notes.push("non-parent-source"); return; }
    var msg = e.data;
    if (port) {
      stats.parentMessagesAfterBootstrap++;
      if (msg && msg.type === "render") stats.parentRenderAttemptsAfterBootstrap++;
      if (msg && msg.type === "bootstrap") stats.bootstrapRejected++;
      // Report the refusal over the private port, never act on it.
      try {
        port.postMessage({
          type: "parent-message-refused",
          v: 1,
          kind: msg && msg.type ? String(msg.type) : typeof msg,
          hadPorts: !!(e.ports && e.ports.length)
        });
      } catch (err) {}
      return;
    }
    if (!msg || typeof msg !== "object" || msg.type !== "bootstrap" || msg.v !== 1) {
      stats.parentMessagesBeforeBootstrap++;
      stats.notes.push("pre-bootstrap-non-bootstrap");
      return;
    }
    if (!e.ports || e.ports.length !== 1) {
      stats.bootstrapRejected++;
      stats.notes.push("bootstrap-without-single-port");
      return;
    }
    stats.bootstrapAccepted++;
    port = e.ports[0];
    stats.portInstalled = true;
    port.onmessage = onPortMessage;
    if (port.start) port.start();
    port.postMessage({ type: "frame-ready", v: 1, origin: String(location.origin) });
  });

  // The single message the frame sends to its parent: liveness. Everything
  // afterwards travels over the private port.
  parentWin.postMessage({ type: "frame-alive", origin: String(location.origin) }, "*");
})();
