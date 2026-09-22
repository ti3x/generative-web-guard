// Trusted host side of the rendering path. Creates the sandboxed frame,
// speaks the postMessage protocol, and validates every event coming back.
//
// Frame document properties (all set here, nowhere else):
//   * <iframe sandbox="allow-scripts"> with no allow-same-origin, so the frame
//     has an opaque (null) origin and no access to the host's DOM, storage,
//     cookies or credentials. No allow-forms, popups, or navigation.
//   * srcdoc with a <meta> CSP: default-src 'none', script-src and style-src
//     limited to the hashes of the bundled frame script and stylesheet,
//     require-trusted-types-for 'script' with trusted-types 'none'.
//   * The only content that ever enters the frame after creation is a
//     structured tree over its private policy Worker port. No parent render route.
//
// CSP inheritance: a srcdoc document inherits the embedding page's policy and
// then adds its own <meta> policy; both must pass. The host page's CSP must
// therefore include 'sha256-<manifest.scriptHash>' in script-src and
// 'sha256-<manifest.cssHash>' in style-src, or the frame will not start.
// This is a feature: the frame can only ever be stricter than the host.
// Verified negatively on Chromium 140, Firefox 141 and WebKit 26: removing the
// script hash from the host policy killed the frame on all three; removing the
// style hash left it working but unstyled. See docs/csp.md.
//
// `frame-src` is NOT a control for this frame. With `frame-src 'none'` in the
// host policy the srcdoc frame still loaded, bootstrapped and rendered on all
// three engines, because about:srcdoc inherits its creator instead of going
// through a navigation fetch. Containment here comes from the opaque origin,
// the absence of allow-same-origin, and the frame's own <meta> policy.
//
// Trusted Types is a Chromium/WebKit-only layer: Firefox 141 does not
// implement require-trusted-types-for or trusted-types, and
// window.trustedTypes is undefined inside the frame there. The sink hardening
// in src/frame.js is the equivalent on that engine. The frame reports which
// of the two it got in its ready message.

import { FRAME_PROTOCOL_VERSION } from "./frame-protocol.js";
import {
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  STARTUP_WARNINGS,
  StartupError,
} from "./startup.js";

const EVENT_TYPES = new Set([
  "click", "input", "change", "keydown", "pointermove", "pointerenter", "pointerleave",
]);
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_STRING = 2000;

function optionalString(v) {
  return v === undefined || (typeof v === "string" && v.length <= MAX_STRING);
}
function optionalBool(v) {
  return v === undefined || typeof v === "boolean";
}
function optionalInt(v) {
  return v === undefined || (Number.isInteger(v) && Math.abs(v) <= 1e6);
}

// Shape check for events from the frame. Returns a fresh plain object with
// only known fields, so nothing else from the frame reaches the runtime.
export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Read own properties only, so nothing inherited through a prototype counts.
  const own = (k) => (Object.hasOwn(raw, k) ? raw[k] : undefined);
  const e = {};
  for (const k of ["type", "action", "value", "dataValue", "dataKey", "key", "checked", "x", "y"]) e[k] = own(k);
  if (!EVENT_TYPES.has(e.type)) return null;
  if (typeof e.action !== "string" || !IDENT_RE.test(e.action)) return null;
  if (!optionalString(e.value) || !optionalString(e.dataValue) || !optionalString(e.dataKey)) return null;
  if (!optionalString(e.key) || !optionalBool(e.checked) || !optionalInt(e.x) || !optionalInt(e.y)) return null;
  const out = { type: e.type, action: e.action };
  for (const k of ["value", "dataValue", "dataKey", "key", "checked", "x", "y"]) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  return out;
}

export function buildFrameDocument(manifest) {
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${manifest.scriptHash}'`,
    `style-src 'sha256-${manifest.cssHash}'`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  // Only fixed, build-time strings are interpolated here. The script and CSS
  // are hashed by the build and the CSP above pins them.
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    "<meta name=\"referrer\" content=\"no-referrer\">" +
    "<meta name=\"color-scheme\" content=\"light dark\">" +
    `<style>${manifest.css}</style>` +
    "</head><body><div id=\"root\"></div>" +
    `<script>${manifest.script}</script>` +
    "</body></html>"
  );
}

export function createSandboxFrame({
  container,
  manifest,
  onEvent,
  onStatus,
  title = "Generated content",
  startupTimeoutMs = STARTUP_TIMEOUTS.frameBootstrapMs,
}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const iframe = doc.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", title);
  iframe.setAttribute("loading", "eager");
  iframe.srcdoc = buildFrameDocument(manifest);

  let ready = false;
  let destroyed = false;
  let loads = 0;
  // Private-port state (src/frame-protocol.js). Once the frame reports
  // `bound`, the host only wires ports, and trees
  // reach the frame from the policy Worker.
  let portBound = false;
  let pendingBootstrap = null; // { message, port, resolve } held until the frame is ready
  let bootstrapResolve = null;
  let settleBound = null;
  const boundPromise = new Promise((resolve) => { settleBound = resolve; });

  const status = (kind, detail) => { try { onStatus?.({ kind, detail }); } catch { /* host callback */ } };

  function reloaded() {
    if (destroyed) return;
    api.destroy();
    status("frame-reloaded", { code: "frame-reloaded", detail: "the frame navigated; recreate the guard" });
  }
  function onLoad() { if (++loads > 1) reloaded(); }

  // ---- frame-bootstrap stage -------------------------------------------
  // This stage has its own budget and its own code because it is the one
  // failure the host cannot diagnose any other way. If the host policy omits
  // this build's frame script hash, the frame's inline script is refused, the
  // violation belongs to the frame's document, the frame's script never runs
  // to report anything, and the host receives NO securitypolicyviolation
  // event on Chromium, Firefox or WebKit. A timeout is the only signal that
  // exists, so the error must name what to check without claiming a cause.
  let settleReady = null;
  let failReady = null;
  const readyPromise = new Promise((resolve, reject) => { settleReady = resolve; failReady = reject; });
  // Nobody is obliged to await this; keep an unobserved rejection quiet.
  readyPromise.catch(() => {});
  const bootstrapTimer = setTimeout(() => {
    if (ready || destroyed) return;
    const error = new StartupError("frame-bootstrap-timeout", {
      timeoutMs: startupTimeoutMs,
      component: "frame",
      detail: `required in the host policy: script-src 'sha256-${manifest.scriptHash}' and style-src 'sha256-${manifest.cssHash}'`,
    });
    status("startup-failed", error.toJSON());
    failReady(error);
  }, startupTimeoutMs);


  function postBootstrap({ message, port }) {
    try {
      iframe.contentWindow.postMessage(message, "*", [port]);
      return true;
    } catch (error) {
      try { port.close(); } catch { /* detached */ }
      status("bootstrap-failed", String(error && error.message).slice(0, 200));
      return false;
    }
  }

  function onMessage(e) {
    if (destroyed) return;
    if (e.source !== iframe.contentWindow) return;
    if (e.origin !== "null") return; // sandboxed srcdoc frames report a null origin
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready": {
        if (ready) { reloaded(); return; }
        ready = true;
        clearTimeout(bootstrapTimer);
        const info = {
          styleSheets: typeof msg.styleSheets === "number" ? msg.styleSheets : -1,
          // Firefox 141 does not implement require-trusted-types-for /
          // trusted-types at all, so window.trustedTypes is undefined inside
          // the frame. The frame's JS sink hardening is the only equivalent
          // there. Reported, not treated as a failure. See docs/csp.md.
          trustedTypes: msg.trustedTypes === true,
        };
        status("ready", info);
        if (info.styleSheets === 0) {
          status("startup-warning", {
            code: "frame-style-hash-missing",
            hint: STARTUP_WARNINGS["frame-style-hash-missing"],
            stage: STARTUP_STAGES.frameBootstrap,
            detail: `style-src must contain 'sha256-${manifest.cssHash}'`,
          });
        }
        settleReady(info);
        if (pendingBootstrap) {
          const b = pendingBootstrap;
          pendingBootstrap = null;
          bootstrapResolve = b.resolve;
          if (!postBootstrap(b)) { bootstrapResolve = null; b.resolve(false); }
        }
        break;
      }
      case "bound": {
        portBound = true;
        status("bound", {
          instanceId: String(msg.instanceId).slice(0, 128),
          sessionId: String(msg.sessionId).slice(0, 128),
        });
        if (bootstrapResolve) { const resolve = bootstrapResolve; bootstrapResolve = null; resolve(true); }
        if (settleBound) { settleBound(true); settleBound = null; }
        break;
      }
      case "refused": {
        status("refused", String(msg.reason).slice(0, 500));
        break;
      }
      case "event": {
        const ev = sanitizeEvent(msg.event);
        if (ev && onEvent) { try { onEvent(ev); } catch { /* host callback */ } }
        break;
      }
      default:
        break;
    }
  }

  win.addEventListener("message", onMessage);
  iframe.addEventListener("load", onLoad);
  container.appendChild(iframe);

  const api = {
    /**
     * Hand the frame its end of the private channel to the policy Worker
     * (src/frame-protocol.js). Resolves true once the frame reports `bound`,
     * false if the bootstrap could not be posted, was superseded by a newer
     * one, or the frame was destroyed; the caller's stage timeout bounds the
     * wait. There is no parent render API: trees reach the frame only from
     * the policy Worker.
     */
    attachPort(port, { instanceId, sessionId }) {
      if (destroyed) { port.close(); return Promise.resolve(false); }
      const message = { type: "bootstrap", protocol: FRAME_PROTOCOL_VERSION, instanceId, sessionId };
      return new Promise((resolve) => {
        if (bootstrapResolve) { bootstrapResolve(false); bootstrapResolve = null; }
        if (pendingBootstrap) { pendingBootstrap.port.close(); pendingBootstrap.resolve(false); pendingBootstrap = null; }
        if (!ready) { pendingBootstrap = { message, port, resolve }; return; }
        bootstrapResolve = resolve;
        if (!postBootstrap({ message, port })) { bootstrapResolve = null; resolve(false); }
      });
    },
    /** True once the frame renders only what the policy Worker delivers. */
    get portBound() { return portBound; },
    /**
     * Resolves true the first time the frame reports `bound`, false if the
     * frame is destroyed first. Never rejects; the caller's stage timeout
     * bounds the wait. Later port replacements do not reset it: once bound,
     * the frame stays bound.
     */
    whenBound() { return boundPromise; },
    /**
     * Resolves with { styleSheets, trustedTypes } when the frame has
     * bootstrapped, or rejects with a StartupError carrying
     * `frame-bootstrap-timeout` and the two hashes the host policy needs.
     * Safe to ignore: it is pre-caught, so not awaiting it is not an
     * unhandled rejection.
     */
    ready: readyPromise,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (!ready) failReady(new Error("frame destroyed before startup completed"));
      portBound = false;
      clearTimeout(bootstrapTimer);
      if (bootstrapResolve) { bootstrapResolve(false); bootstrapResolve = null; }
      if (pendingBootstrap) { pendingBootstrap.port.close(); pendingBootstrap.resolve(false); pendingBootstrap = null; }
      if (settleBound) { settleBound(false); settleBound = null; }
      win.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      iframe.remove();
    },
    get element() {
      return iframe;
    },
  };
  return api;
}
