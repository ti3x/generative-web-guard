// Cross-origin CDN library entry point for the end-to-end topology test:
// this module (loaded from the CDN origin) creates BOTH Workers and the
// opaque-origin frame, transfers the two ends of one MessageChannel, and
// proves a render round trip that only the policy Worker can start.
export const guardModuleUrl = import.meta.url;

const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));

function makeWorker(mode, url, cdn) {
  const name = JSON.stringify({ url, cdn });
  if (mode === "blob") {
    // Blob worker: same-origin-as-creator local scheme, so it inherits the
    // host document's CSP, then imports the cross-origin payload.
    return new Worker(blobUrl(`await import(${JSON.stringify(url)});`), { type: "module", name });
  }
  // Same-origin shim: the worker script is fetched from the host, so its policy
  // comes from the shim response, not from the host document.
  return new Worker("/worker-shim.js", { type: "module", name });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

export async function createGuard({ frameDoc, container, mode, cdn }) {
  const log = { mode, guardModuleUrl: import.meta.url, steps: {} };
  const err = (e) => `${e.name}: ${String(e.message).slice(0, 200)}`;

  // 1. opaque-origin frame
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.srcdoc = frameDoc;
  const alive = [];
  window.addEventListener("message", (e) => {
    if (e.source === iframe.contentWindow && e.data && e.data.type === "frame-alive") alive.push(e.data);
  });
  container.appendChild(iframe);
  log.steps.frameAlive = await waitFor(() => (alive.length ? alive[0] : null), 6000, "frame-alive");

  // 2. the two Workers, both created by this cross-origin module
  const execEvents = [];
  const policyEvents = [];
  let exec = null;
  let policy = null;
  try { exec = makeWorker(mode, `${cdn}/worker-probe.js`, cdn); log.steps.execWorkerCreate = "ok"; }
  catch (e) { log.steps.execWorkerCreate = err(e); }
  try { policy = makeWorker(mode, `${cdn}/policy-worker.js`, cdn); log.steps.policyWorkerCreate = "ok"; }
  catch (e) { log.steps.policyWorkerCreate = err(e); }
  if (exec) {
    exec.onmessage = (e) => execEvents.push(e.data);
    exec.onerror = (e) => execEvents.push({ type: "worker-error", message: String(e.message || e.type) });
  }
  if (policy) {
    policy.onmessage = (e) => policyEvents.push(e.data);
    policy.onerror = (e) => policyEvents.push({ type: "worker-error", message: String(e.message || e.type) });
  }
  log.steps.execWorkerReady = await waitFor(
    () => execEvents.find((m) => m && (m.type === "probe-result" || m.type === "worker-error" || m.type === "shim-import-failed")) || null,
    6000, "exec worker ready");
  if (!policy) { log.steps.fatal = "no policy worker"; return log; }

  // 3. one channel; opposite ends to the policy Worker and to the frame
  const channel = new MessageChannel();
  policy.postMessage({ type: "install-port" }, [channel.port1]);
  log.steps.portInstalled = await waitFor(
    () => policyEvents.find((m) => m && (m.type === "port-installed" || m.type === "worker-error" || m.type === "shim-import-failed")) || null,
    6000, "port-installed");
  try {
    iframe.contentWindow.postMessage({ type: "bootstrap", v: 1 }, "*", [channel.port2]);
    log.steps.bootstrap = "ok";
  } catch (e) { log.steps.bootstrap = err(e); }
  log.steps.frameReadySeenByPolicyWorker = await waitFor(
    () => policyEvents.find((m) => m && m.type === "frame-ready-seen") || null, 6000, "frame-ready-seen");

  // 4. wasm inside the policy Worker (Lean checker stand-in)
  policy.postMessage({ type: "probe-wasm" });
  log.steps.policyWorkerWasm = await waitFor(
    () => policyEvents.find((m) => m && m.type === "wasm-probe") || null, 6000, "policy worker wasm");

  // 5. render round trip, acknowledged by the frame over the private port
  const settled = (id) => policyEvents.find((m) => m && m.type === "render-settled" && m.requestId === id) || null;
  const t0 = performance.now();
  policy.postMessage({ type: "render", requestId: "e2e-1", generation: 1, text: "end-to-end-accepted" });
  log.steps.render = await waitFor(() => settled("e2e-1"), 8000, "render ack");
  log.steps.renderMs = Math.round(performance.now() - t0);

  // 6. the host tries to render directly; the frame must refuse
  iframe.contentWindow.postMessage(
    { type: "render", v: 1, requestId: "host-evil", generation: 99, nodes: [{ tag: "p", text: "HOST-INJECTED" }] }, "*");
  await wait(300);
  policy.postMessage({ type: "get-stats" });
  log.steps.frameStats = await waitFor(
    () => policyEvents.find((m) => m && m.type === "frame-stats") || null, 5000, "frame stats");

  log.steps.execWorkerProbe = execEvents.find((m) => m && m.type === "probe-result") || null;
  log.steps.policyEventTypes = policyEvents.map((m) => (m && m.type) || String(m));
  log.steps.execEventTypes = execEvents.map((m) => (m && m.type) || String(m));
  return log;
}
