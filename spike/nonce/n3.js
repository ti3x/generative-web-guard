// Host bootstrap module for n3. Question 5: do the srcdoc frame's pinned
// sha256 hashes survive inheritance of a 'strict-dynamic' host policy?
//
// CSP3 says 'strict-dynamic' ignores host-sources, scheme-sources, 'self' and
// 'unsafe-inline' but leaves nonces and hashes effective. The frame inherits
// the host document's policy, so the frame's inline script must match the
// host policy's 'sha256-<frameScript>' as well as the frame's own meta policy.
// A failure here means the frame never starts and nothing reports why.
//
// The frame document is injected by the server (placeholder on line 14); it is
// the same construction as src/host.js buildFrameDocument. ?frameNonce=1 makes the
// server add the page nonce to the frame's inline script tag and to the frame's
// own meta policy, which is the contingency path if hashes turn out to be dead.
const FRAME_DOC = {FRAME_DOC_JSON};
const R = window.__result;
R.steps.bootstrapNeverRan = false;
R.steps.hostModuleRan = true;
R.steps.frameCsp = "{FRAME_CSP}";

const alive = [];
const fromPort = [];
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts");
iframe.setAttribute("referrerpolicy", "no-referrer");
window.addEventListener("message", (e) => {
  if (e.source === iframe.contentWindow && e.data && e.data.type === "frame-alive") alive.push(e.data);
});
iframe.srcdoc = FRAME_DOC;
document.getElementById("host").appendChild(iframe);

const waitFor = (pred, ms, label) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const v = pred();
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return resolve({ timeout: label });
    setTimeout(tick, 25);
  };
  tick();
});

R.steps.frameAlive = await waitFor(() => (alive.length ? alive[0] : null), 5000, "frame-alive");

// If the frame's script ran, drive one render over a private MessagePort, the
// way the policy Worker would, and read the acknowledgement back.
const channel = new MessageChannel();
channel.port1.onmessage = (e) => fromPort.push(e.data);
try {
  iframe.contentWindow.postMessage({ type: "bootstrap", v: 1 }, "*", [channel.port2]);
  R.steps.bootstrapPosted = "ok";
} catch (e) {
  R.steps.bootstrapPosted = e.name + ": " + String(e.message).slice(0, 160);
}
R.steps.frameReady = await waitFor(() => fromPort.find((m) => m && m.type === "frame-ready") || null, 4000, "frame-ready");
channel.port1.postMessage({ type: "render", v: 1, requestId: "n3-1", generation: 1, nodes: [{ tag: "p", text: "nonce-render-accepted" }] });
R.steps.committed = await waitFor(() => fromPort.find((m) => m && m.type === "committed") || null, 4000, "committed");

document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__done = true;
