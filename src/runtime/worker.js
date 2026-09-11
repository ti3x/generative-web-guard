// Web Worker entry. Loads QuickJS (single-file Wasm variant, no network
// fetch needed) and services load/init/step requests from the controller.
// The worker exposes nothing to the program; it only relays JSON strings.

import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createCore } from "./core.js";

let corePromise = null;

function getCore() {
  if (!corePromise) {
    corePromise = newQuickJSWASMModuleFromVariant(variant).then((QuickJS) => createCore(QuickJS));
  }
  return corePromise;
}

self.addEventListener("message", async (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
  try {
    const core = await getCore();
    let result;
    switch (msg.type) {
      case "load":
        core.load(msg.source, typeof msg.data === "string" ? msg.data : null);
        result = { ok: true };
        break;
      case "init":
        result = core.init();
        break;
      case "step":
        result = core.step(msg.state, msg.event);
        break;
      default:
        throw new Error("unknown request");
    }
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err).slice(0, 2000) });
  }
});
