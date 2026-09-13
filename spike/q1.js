// Host side of spike question 1 / 5.
//
// Topology under test (refactor.md "Target data flow"): the host creates the
// policy Worker and a MessageChannel, transfers port1 to the policy Worker and
// port2 into an opaque-origin sandbox="allow-scripts" frame with a single
// bootstrap postMessage, and never renders itself. The frame must then refuse
// every later parent message and acknowledge commits over the port.
import { FRAME_DOC, SCRIPT_HASH, CSS_HASH, FRAME_CSP } from "/frame-doc.js";

const R = { question: "q1", scriptHash: SCRIPT_HASH, cssHash: CSS_HASH, frameCsp: FRAME_CSP, steps: {}, violations: [] };
const out = document.getElementById("out");
const finish = () => {
  out.textContent = JSON.stringify(R, null, 1);
  window.__result = R;
  window.__done = true;
};
document.addEventListener("securitypolicyviolation", (e) => {
  R.violations.push({
    effectiveDirective: e.effectiveDirective || e.violatedDirective,
    blockedURI: String(e.blockedURI).slice(0, 120),
    sourceFile: String(e.sourceFile || "").slice(0, 120),
    documentURI: String(e.documentURI || "").slice(0, 120)
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(pred, ms, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = pred();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return resolve({ timeout: label });
      setTimeout(tick, 25);
    };
    tick();
  });
}

try {
  // --- frame creation -------------------------------------------------------
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.srcdoc = FRAME_DOC;
  const alive = [];
  const fromFrame = [];
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    fromFrame.push({ origin: e.origin, data: e.data });
    if (e.data && e.data.type === "frame-alive") alive.push(e.data);
  });
  document.getElementById("host").appendChild(iframe);

  const aliveRes = await waitFor(() => (alive.length ? alive[0] : null), 6000, "frame-alive");
  R.steps.frameAlive = aliveRes;
  R.steps.frameMessages = fromFrame.map((m) => ({ origin: m.origin, type: m.data && m.data.type }));

  // --- policy worker --------------------------------------------------------
  const workerEvents = [];
  let worker = null;
  try {
    worker = new Worker("/policy-worker.js");
    R.steps.policyWorkerCreate = "ok";
  } catch (e) {
    R.steps.policyWorkerCreate = `throw ${e.name}: ${e.message}`;
  }
  if (worker) {
    worker.onerror = (e) => workerEvents.push({ type: "worker-error", message: String(e.message || e.type) });
    worker.onmessage = (e) => workerEvents.push(e.data);

    const channel = new MessageChannel();
    worker.postMessage({ type: "install-port" }, [channel.port1]);
    R.steps.portInstalled = await waitFor(
      () => workerEvents.find((m) => m && m.type === "port-installed") || null, 3000, "port-installed");

    // One-time bootstrap: transfer the frame's end. targetOrigin must be "*"
    // because the frame's origin is opaque.
    let bootstrapError = null;
    try {
      iframe.contentWindow.postMessage({ type: "bootstrap", v: 1 }, "*", [channel.port2]);
    } catch (e) { bootstrapError = `${e.name}: ${e.message}`; }
    R.steps.bootstrapPostMessage = bootstrapError || "ok";
    R.steps.frameReadySeen = await waitFor(
      () => workerEvents.find((m) => m && m.type === "frame-ready-seen") || null, 4000, "frame-ready-seen");

    // --- render over the private port, expect a commit acknowledgement ------
    const settled = (id) => workerEvents.find((m) => m && m.type === "render-settled" && m.requestId === id) || null;
    worker.postMessage({ type: "render", requestId: "r1", generation: 1, text: "accepted-tree-1" });
    R.steps.render1 = await waitFor(() => settled("r1"), 5000, "render r1 ack");

    // --- the parent tries to render directly --------------------------------
    const domBefore = await frameDomText(iframe);
    iframe.contentWindow.postMessage(
      { type: "render", v: 1, requestId: "parent-evil", generation: 99,
        nodes: [{ tag: "p", text: "PARENT-INJECTED" }] }, "*");
    await sleep(400);
    // Evidence comes from the frame itself over the port (the host cannot read
    // an opaque-origin DOM) and, independently, from the driver.
    worker.postMessage({ type: "get-stats" });
    const statsAfterInjection = await waitFor(
      () => workerEvents.find((m) => m && m.type === "frame-stats") || null, 4000, "frame stats");
    R.steps.parentDirectRender = {
      hostReadOfFrameDom: domBefore,
      frameStats: statsAfterInjection
    };

    // --- the parent tries a second bootstrap with a fresh port --------------
    const ch2 = new MessageChannel();
    const ch2Messages = [];
    ch2.port1.onmessage = (e) => ch2Messages.push(e.data);
    ch2.port1.start && ch2.port1.start();
    iframe.contentWindow.postMessage({ type: "bootstrap", v: 1 }, "*", [ch2.port2]);
    await sleep(300);
    ch2.port1.postMessage({ type: "render", v: 1, requestId: "second-port", generation: 100,
      nodes: [{ tag: "p", text: "SECOND-PORT-INJECTED" }] });
    await sleep(500);
    R.steps.secondBootstrap = { secondPortReplies: ch2Messages };

    // --- supersession: a newer generation commits, an older one is stale ----
    worker.postMessage({ type: "render", requestId: "r2", generation: 2, text: "accepted-tree-2" });
    R.steps.render2 = await waitFor(() => settled("r2"), 5000, "render r2 ack");
    worker.postMessage({ type: "render", requestId: "r3-stale", generation: 1, text: "STALE" });
    R.steps.renderStale = await waitFor(() => settled("r3-stale"), 5000, "stale settle");

    // --- worker-side Wasm probe (question 3, same-origin worker) ------------
    worker.postMessage({ type: "probe-wasm" });
    R.steps.workerWasm = await waitFor(
      () => workerEvents.find((m) => m && m.type === "wasm-probe") || null, 4000, "wasm probe");

    worker.postMessage({ type: "get-stats" });
    await sleep(400);
    const allStats = workerEvents.filter((m) => m && m.type === "frame-stats");
    R.steps.finalFrameStats = allStats.length ? allStats[allStats.length - 1] : null;
    R.steps.frameRefusalsSeenOverPort = workerEvents.filter((m) => m && m.type === "port-observed").map((m) => m.data);
    R.steps.workerEventTypes = workerEvents.map((m) => (m && m.type) || String(m));
    R.steps.finalDomText = await frameDomText(iframe);
  }
} catch (e) {
  R.fatal = `${e.name}: ${e.message}`;
}

// The host cannot read the opaque frame's DOM; the driver does that directly.
// Here we only record what the port told us, so `null` is expected.
async function frameDomText(iframe) {
  try { return iframe.contentDocument ? iframe.contentDocument.body.textContent : null; }
  catch (e) { return `blocked:${e.name}`; }
}

finish();
