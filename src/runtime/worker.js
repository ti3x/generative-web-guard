// Web Worker entry. Loads QuickJS (single-file Wasm variant, no network
// fetch needed) and services load/init/step requests from the controller.
// The worker exposes nothing to the program; it only relays JSON strings.
//
// Both directions are validated against ./protocol.js. A request is checked
// before QuickJS is touched, so a malformed or oversized request never
// reaches the runtime, and every result is checked before it is posted, so an
// oversized or wrongly shaped packet never leaves the worker even if the core
// were to change. The controller applies the same rules on receipt: this is
// the outgoing half of one shared definition, not a second opinion.
//
// Diagnostics are bounded strings produced by the host side of the boundary.
// A guest value is never coerced into an error message here.

import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createCore } from "./core.js";
import { DEFAULT_LIMITS, PROTOCOL_VERSION, checkRequest, checkResult, errorText } from "./protocol.js";

let corePromise = null;

function getCore() {
  if (!corePromise) {
    corePromise = newQuickJSWASMModuleFromVariant(variant).then((QuickJS) => createCore(QuickJS));
  }
  return corePromise;
}

function reply(id, body) {
  self.postMessage({ v: PROTOCOL_VERSION, id, ...body });
}

self.addEventListener("message", async (e) => {
  const msg = e.data;
  const problem = checkRequest(msg, DEFAULT_LIMITS);
  if (problem) {
    // A rejected request is still answered when it carries a usable id, so
    // the controller settles it immediately instead of waiting for its
    // watchdog. Without an id there is no request to answer and the
    // controller's watchdog is the only remaining bound.
    const id = msg && typeof msg === "object" && Number.isSafeInteger(msg.id) ? msg.id : null;
    if (id !== null) reply(id, { ok: false, error: `protocol: ${problem}` });
    return;
  }
  try {
    const core = await getCore();
    let result;
    switch (msg.type) {
      case "load":
        core.load(msg.source, msg.data);
        result = { loaded: true };
        break;
      case "init":
        result = core.init();
        break;
      default:
        result = core.step(msg.state, msg.event);
        break;
    }
    const bad = checkResult(msg.type, result, DEFAULT_LIMITS);
    if (bad) throw new Error(`protocol: ${bad}`);
    reply(msg.id, { ok: true, result });
  } catch (err) {
    reply(msg.id, { ok: false, error: errorText(err, DEFAULT_LIMITS.maxDiagnosticChars) });
  }
});
