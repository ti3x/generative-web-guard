// Cross-origin "library" entry point for the end-to-end check, adapted from
// spike/cdn-guard.js. blob: mode only: the first spike established that a
// Worker script can never be fetched from the CDN origin, and Profile B's
// same-origin shim is out of scope here.
export const guardModuleUrl = import.meta.url;

const CDN = "{CDN}";
const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
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

// Both payloads travel as source inside this module, exactly as src/cdn-full.js
// does, so nothing is fetched from the CDN origin by a Worker.
const POLICY_SRC = {POLICY_WORKER_SRC};

export async function createGuard({ frameDoc, container }) {
  const log = { guardModuleUrl: import.meta.url, steps: {} };
  const err = (e) => e.name + ": " + String(e.message).slice(0, 200);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  const alive = [];
  window.addEventListener("message", (e) => {
    if (e.source === iframe.contentWindow && e.data && e.data.type === "frame-alive") alive.push(e.data);
  });
  iframe.srcdoc = frameDoc;
  container.appendChild(iframe);
  log.steps.frameAlive = await waitFor(() => (alive.length ? alive[0] : null), 5000, "frame-alive");

  const policyEvents = [];
  let policy = null;
  try {
    policy = new Worker(blobUrl(POLICY_SRC), { name: JSON.stringify({ cdn: CDN }) });
    log.steps.policyWorkerCreate = "ok";
  } catch (e) {
    log.steps.policyWorkerCreate = err(e);
  }
  if (!policy) { log.steps.fatal = "no policy worker"; return log; }
  policy.onmessage = (e) => policyEvents.push(e.data);
  policy.onerror = (e) => policyEvents.push({ type: "worker-error", message: String((e && e.message) || (e && e.type)) });

  const channel = new MessageChannel();
  policy.postMessage({ type: "install-port" }, [channel.port1]);
  log.steps.portInstalled = await waitFor(
    () => policyEvents.find((m) => m && (m.type === "port-installed" || m.type === "worker-error")) || null,
    5000, "port-installed");
  try {
    iframe.contentWindow.postMessage({ type: "bootstrap", v: 1 }, "*", [channel.port2]);
    log.steps.bootstrap = "ok";
  } catch (e) { log.steps.bootstrap = err(e); }
  log.steps.frameReadySeenByPolicyWorker = await waitFor(
    () => policyEvents.find((m) => m && m.type === "frame-ready-seen") || null, 5000, "frame-ready-seen");

  policy.postMessage({ type: "probe-wasm" });
  log.steps.policyWorkerWasm = await waitFor(
    () => policyEvents.find((m) => m && m.type === "wasm-probe") || null, 6000, "policy worker wasm");

  const t0 = performance.now();
  policy.postMessage({ type: "render", requestId: "e2e-1", generation: 1, text: "nonce-end-to-end-accepted" });
  log.steps.render = await waitFor(
    () => policyEvents.find((m) => m && m.type === "render-settled" && m.requestId === "e2e-1") || null, 8000, "render ack");
  log.steps.renderMs = Math.round(performance.now() - t0);

  iframe.contentWindow.postMessage(
    { type: "render", v: 1, requestId: "host-evil", generation: 99, nodes: [{ tag: "p", text: "HOST-INJECTED" }] }, "*");
  await wait(250);
  policy.postMessage({ type: "get-stats" });
  log.steps.frameStats = await waitFor(
    () => policyEvents.find((m) => m && m.type === "frame-stats") || null, 5000, "frame stats");
  log.steps.policyEventTypes = policyEvents.map((m) => (m && m.type) || String(m));
  return log;
}
