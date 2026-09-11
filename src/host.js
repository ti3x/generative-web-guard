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

import { isValidated } from "./policy.js";

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

export function createSandboxFrame({ container, manifest, onEvent, onStatus, title = "Generated content" }) {
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

  const status = (kind, detail) => onStatus && onStatus({ kind, detail });

  function send(msg) {
    iframe.contentWindow.postMessage(msg, "*"); // frame origin is null
  }

  function onMessage(e) {
    if (destroyed) return;
    if (e.source !== iframe.contentWindow) return;
    if (e.origin !== "null") return; // sandboxed srcdoc frames report a null origin
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        ready = true;
        status("ready");
        if (queued) {
          const t = queued;
          queued = null;
          api.render(t);
        }
        break;
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

  const api = {
    // Accepts only a tree that is a fixed point of the policy. The host checks
    // this too, so a caller holding an arbitrary object cannot get it rendered.
    render(tree) {
      if (destroyed) return Promise.resolve(false);
      if (!isValidated(tree)) {
        status("refused", "host: tree is not validated");
        return Promise.resolve(false);
      }
      if (!ready) {
        queued = tree;
        return Promise.resolve(true);
      }
      const mySeq = ++seq;
      return new Promise((resolve) => {
        pending.set(mySeq, resolve);
        send({ type: "render", seq: mySeq, tree });
      });
    },
    clear() {
      if (ready && !destroyed) send({ type: "clear" });
    },
    destroy() {
      destroyed = true;
      win.removeEventListener("message", onMessage);
      iframe.remove();
    },
    get element() {
      return iframe;
    },
  };
  return api;
}
