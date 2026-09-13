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
//     structured tree over postMessage. The frame re-validates it.
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

import { isValidated } from "./policy.js";
import { isAcceptanceToken } from "./acceptance.js";
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
  claimAcceptance = null,
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
  let seq = 0;
  let queued = null;
  let destroyed = false;
  const pending = new Map(); // seq -> resolve
  // Private-port state (src/frame-protocol.js). Once the frame reports
  // `bound`, the host never sends a tree again: it only wires ports, and trees
  // reach the frame from the policy Worker.
  let portBound = false;
  let pendingBootstrap = null; // { message, port, resolve } held until the frame is ready
  let bootstrapResolve = null;
  let settleBound = null;
  const boundPromise = new Promise((resolve) => { settleBound = resolve; });

  const status = (kind, detail) => onStatus && onStatus({ kind, detail });

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

  function send(msg) {
    iframe.contentWindow.postMessage(msg, "*"); // frame origin is null
  }

  function postBootstrap({ message, port }) {
    try {
      iframe.contentWindow.postMessage(message, "*", [port]);
      return true;
    } catch (error) {
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
        if (queued && !portBound) {
          // `queued` is a tree whose acceptance was already claimed, so it is
          // committed directly rather than going back through resolveRender.
          const t = queued;
          queued = null;
          if (isValidated(t)) {
            const mySeq = ++seq;
            send({ type: "render", seq: mySeq, tree: t });
          } else {
            status("refused", "host: queued tree is not validated");
          }
        }
        break;
      }
      case "bound": {
        portBound = true;
        queued = null; // a tree held for the parent route can no longer be committed
        status("bound", {
          instanceId: String(msg.instanceId).slice(0, 128),
          sessionId: String(msg.sessionId).slice(0, 128),
        });
        if (bootstrapResolve) { const resolve = bootstrapResolve; bootstrapResolve = null; resolve(true); }
        if (settleBound) { settleBound(true); settleBound = null; }
        break;
      }
      case "rendered":
      case "refused": {
        const resolve = pending.get(msg.seq);
        pending.delete(msg.seq);
        if (msg.type === "refused") status("refused", String(msg.reason).slice(0, 500));
        if (resolve) resolve(msg.type === "rendered");
        break;
      }
      case "event": {
        const ev = sanitizeEvent(msg.event);
        if (ev && onEvent) onEvent(ev);
        break;
      }
      default:
        break;
    }
  }

  win.addEventListener("message", onMessage);
  container.appendChild(iframe);

  /**
   * Resolve what to render.
   *
   * With `claimAcceptance` configured -- which is what `createGuardFrame` and
   * both demos do -- the argument must be a ONE-TIME ACCEPTANCE RECORD minted
   * by the policy Worker next to Lean's verdict, and the tree that gets
   * rendered is the one the policy session stored with that record. The caller
   * does not supply a tree at all, so there is no JavaScript-only route into
   * the frame: a fabricated record has an unknown nonce, a replayed one has a
   * spent nonce, and a superseded one names an old generation. All three are
   * refused here.
   *
   * Without `claimAcceptance` this is the legacy low-level path: the argument
   * is a tree and the only check is the host's own `isValidated` predicate.
   * That path exists for `src/render.js`-level tests and the documented
   * low-level export; it is NOT how the shipped entry points are wired, and
   * Phase 5 is where the remaining callers move off it.
   */
  function resolveRender(input) {
    if (claimAcceptance) {
      if (!isAcceptanceToken(input)) {
        return { ok: false, detail: "host: render requires a policy-worker acceptance record, not a tree" };
      }
      const claimed = claimAcceptance(input);
      if (!claimed || claimed.ok !== true) {
        return { ok: false, detail: `host: acceptance refused (${claimed?.reason?.code ?? "unknown"}${claimed?.reason?.detail ? `: ${claimed.reason.detail}` : ""})` };
      }
      // Defence in depth: the stored tree still has to satisfy the host's own
      // predicate. Redundant while Lean decides, kept until Phase 6.
      if (!isValidated(claimed.tree)) {
        return { ok: false, detail: "host: the accepted tree is not validated by the host predicate" };
      }
      return { ok: true, tree: claimed.tree };
    }
    if (!isValidated(input)) return { ok: false, detail: "host: tree is not validated" };
    return { ok: true, tree: input };
  }

  const api = {
    /**
     * Commit one document. Takes an acceptance record when the frame is wired
     * to a policy session, or a validated tree on the legacy path. Resolves
     * true only after the frame acknowledges the exact request.
     */
    render(input) {
      if (destroyed) return Promise.resolve(false);
      if (portBound) {
        status("refused", "host: frame is bound to the policy port; trees are delivered by the policy Worker");
        return Promise.resolve(false);
      }
      const resolved = resolveRender(input);
      if (!resolved.ok) {
        status("refused", resolved.detail);
        return Promise.resolve(false);
      }
      const tree = resolved.tree;
      if (!ready) {
        // The acceptance is already spent, so hold the tree it produced rather
        // than the record; replaying the record later would be refused.
        queued = tree;
        return Promise.resolve(true);
      }
      const mySeq = ++seq;
      return new Promise((resolve) => {
        pending.set(mySeq, resolve);
        send({ type: "render", seq: mySeq, tree });
      });
    },
    /** True when this frame requires an acceptance record to commit. */
    get requiresAcceptance() { return claimAcceptance !== null; },
    /**
     * Hand the frame its end of the private channel to the policy Worker
     * (src/frame-protocol.js). Resolves true once the frame reports `bound`,
     * false if the bootstrap could not be posted, was superseded by a newer
     * one, or the frame was destroyed; the caller's stage timeout bounds the
     * wait. After this, `render` is refused: trees reach the frame only from
     * the policy Worker.
     */
    attachPort(port, { instanceId, sessionId }) {
      if (destroyed) return Promise.resolve(false);
      const message = { type: "bootstrap", protocol: FRAME_PROTOCOL_VERSION, instanceId, sessionId };
      return new Promise((resolve) => {
        if (bootstrapResolve) { bootstrapResolve(false); bootstrapResolve = null; }
        if (pendingBootstrap) { pendingBootstrap.resolve(false); pendingBootstrap = null; }
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
    clear() {
      if (ready && !destroyed) send({ type: "clear" });
    },
    destroy() {
      destroyed = true;
      clearTimeout(bootstrapTimer);
      if (bootstrapResolve) { bootstrapResolve(false); bootstrapResolve = null; }
      if (pendingBootstrap) { pendingBootstrap.resolve(false); pendingBootstrap = null; }
      if (settleBound) { settleBound(false); settleBound = null; }
      win.removeEventListener("message", onMessage);
      iframe.remove();
    },
    get element() {
      return iframe;
    },
  };
  return api;
}
