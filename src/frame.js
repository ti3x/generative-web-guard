// Code that runs INSIDE the sandboxed, null-origin iframe. It is fixed
// application code; generated content never executes here. Its job:
//
//   1. Receive trees only over the private policy Worker port.
//   2. Check the renderer construction contract, not policy acceptance.
//   3. Render with the structured renderer. No HTML string is ever parsed.
//   4. Convert user interactions on [data-action] elements into plain-data
//      events and post them to the parent.
//
// The frame document carries a CSP with default-src 'none', a script hash for
// this bundle, a style hash for the bundled stylesheet, and Trusted Types
// enforcement with no policies allowed. So even a bug in this file cannot
// inject markup, load a resource or run other script.

import { isTreeShaped } from "./tree.js";
import { createRenderer } from "./render.js";
import { createFrameReceiver } from "./frame-channel.js";
import { FRAME_PROTOCOL_VERSION } from "./frame-protocol.js";

const MAX_EVENT_STRING = 2000;
const FORWARDED_KEYS = new Set([
  "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "Tab",
]);

// Belt and braces for browsers without Trusted Types: make HTML sinks throw so
// a future bug in fixed code fails loudly instead of parsing markup.
function hardenSinks(win) {
  const thrower = (what) => () => { throw new Error(`frame: ${what} is disabled`); };
  const define = (obj, prop, what) => {
    try {
      Object.defineProperty(obj, prop, { configurable: false, set: thrower(what), get: () => "" });
    } catch { /* already locked */ }
  };
  define(win.Element.prototype, "innerHTML", "innerHTML");
  define(win.Element.prototype, "outerHTML", "outerHTML");
  define(win.ShadowRoot.prototype, "innerHTML", "shadowRoot.innerHTML");
  const kill = (obj, prop, what) => {
    try {
      Object.defineProperty(obj, prop, { configurable: false, writable: false, value: thrower(what) });
    } catch { /* already locked */ }
  };
  kill(win.Element.prototype, "insertAdjacentHTML", "insertAdjacentHTML");
  kill(win.Element.prototype, "setHTMLUnsafe", "setHTMLUnsafe");
  kill(win.Document.prototype, "write", "document.write");
  kill(win.Document.prototype, "writeln", "document.writeln");
  kill(win.Range.prototype, "createContextualFragment", "createContextualFragment");
  kill(win, "DOMParser", "DOMParser");
  // eval and Function are already blocked by the frame CSP (no 'unsafe-eval').
}

function bounded(s) {
  return typeof s === "string" ? s.slice(0, MAX_EVENT_STRING) : undefined;
}

export function startFrame(win) {
  const doc = win.document;
  hardenSinks(win);

  const root = doc.getElementById("root");
  const renderer = createRenderer(doc, root);
  const parent = win.parent;
  const post = (msg) => parent.postMessage(msg, "*"); // null origin: parent verifies source

  // Only the private authority port can reach this renderer contract check.
  function commit(tree) {
    if (!isTreeShaped(tree)) return { ok: false, reason: "malformed renderer tree" };
    try {
      renderer.render(tree);
      return { ok: true };
    } catch (err) {
      renderer.clear();
      return { ok: false, reason: String(err && err.message) };
    }
  }

  // Only the private Worker port delivers trees, even before initial binding.
  // A later bootstrap replaces the port without reopening a parent route.
  let receiver = null;
  let bound = null;

  function bootstrap(msg, ports) {
    const port = ports && ports[0];
    if (!port || msg.protocol !== FRAME_PROTOCOL_VERSION) return;
    if (typeof msg.instanceId !== "string" || typeof msg.sessionId !== "string") return;
    if (receiver) receiver.dispose();
    bound = { instanceId: msg.instanceId, sessionId: msg.sessionId };
    receiver = createFrameReceiver(port, { ...bound, onRender: commit });
    post({ type: "bound", instanceId: bound.instanceId, sessionId: bound.sessionId });
  }

  win.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "bootstrap") {
      bootstrap(msg, e.ports);
    } else if (msg.type === "render") {
      const seq = typeof msg.seq === "number" ? msg.seq : -1;
      post({ type: "refused", seq, reason: "trees require the private policy port" });
    }
  });

  function actionTarget(target) {
    if (!(target instanceof win.Element)) return null;
    const el = target.closest("[data-action]");
    if (!el || !root.contains(el)) return null;
    return el;
  }

  function baseEvent(type, el) {
    return {
      type,
      action: el.getAttribute("data-action"),
      dataValue: bounded(el.getAttribute("data-value") ?? undefined),
      dataKey: bounded(el.getAttribute("data-key") ?? undefined),
    };
  }

  function controlFields(el) {
    const out = {};
    if (el instanceof win.HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") out.checked = el.checked;
      else out.value = bounded(el.value);
    } else if (el instanceof win.HTMLSelectElement || el instanceof win.HTMLTextAreaElement) {
      out.value = bounded(el.value);
    }
    return out;
  }

  root.addEventListener("click", (e) => {
    const el = actionTarget(e.target);
    if (!el) return;
    e.preventDefault();
    post({ type: "event", event: { ...baseEvent("click", el), ...controlFields(el) } });
  });

  for (const type of ["input", "change"]) {
    root.addEventListener(type, (e) => {
      const el = actionTarget(e.target);
      if (!el) return;
      post({ type: "event", event: { ...baseEvent(type, el), ...controlFields(e.target) } });
    });
  }

  root.addEventListener("keydown", (e) => {
    const el = actionTarget(e.target);
    if (!el || !FORWARDED_KEYS.has(e.key)) return;
    // Do not swallow Tab; keyboard navigation stays with the browser.
    if (e.key !== "Tab") e.preventDefault();
    post({ type: "event", event: { ...baseEvent("keydown", el), key: e.key, ...controlFields(e.target) } });
  });

  // Pointer events are forwarded only for elements that opt in with
  // data-hover, and pointermove is coalesced to one per animation frame, so
  // tooltips work without turning every click into several updates.
  let pendingPointer = null;
  const flushPointer = () => {
    if (pendingPointer) post({ type: "event", event: pendingPointer });
    pendingPointer = null;
  };
  for (const type of ["pointermove", "pointerenter", "pointerleave"]) {
    root.addEventListener(type, (e) => {
      const el = actionTarget(e.target);
      if (!el || !el.hasAttribute("data-hover")) return;
      const rect = el.getBoundingClientRect();
      const ev = {
        ...baseEvent(type, el),
        x: Math.round(e.clientX - rect.left),
        y: Math.round(e.clientY - rect.top),
      };
      if (type === "pointermove") {
        const first = pendingPointer === null;
        pendingPointer = ev;
        if (first) win.requestAnimationFrame(flushPointer);
      } else {
        post({ type: "event", event: ev });
      }
    }, true);
  }

  // The frame's own CSP violations are not visible to the host: they belong to
  // this document, and if the script hash were missing this line would never
  // run at all. What the frame CAN do is report facts about itself that the
  // host would otherwise have to guess. `styleSheets: 0` means the host's
  // style-src is missing this build's style hash, which degrades appearance
  // and nothing else, so the host warns instead of failing.
  post({
    type: "ready",
    styleSheets: doc.styleSheets ? doc.styleSheets.length : -1,
    trustedTypes: typeof win.trustedTypes !== "undefined",
  });
}

if (typeof window !== "undefined" && window.parent !== window) {
  startFrame(window);
}
