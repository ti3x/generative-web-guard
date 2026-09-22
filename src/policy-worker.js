// Policy Worker entry point (browser Worker / Node worker_threads-free).
//
// The Worker owns bounded parse5 preprocessing, candidate construction and
// LEAN/WASM ACCEPTANCE, and answers one versioned request at a time. It never
// executes generated JavaScript: no eval, no Function, no QuickJS, no
// importScripts, no runtime import of anything.
//
// STARTUP HAS TWO STAGES, REPORTED SEPARATELY
//
//   policy/ready         the payload loaded and the channel works. Posted
//                        immediately. It does NOT mean anything can be
//                        accepted yet, and it must not be read that way.
//   policy/checker-ready the Lean/Wasm authority instantiated, sealed its
//                        class allowlist and stylesheet identity, and reported
//                        an identity and limits this build accepts.
//   policy/failed        the authority could not start. The session is dead.
//
// They are separate because the failures need different fixes: a refused
// blob: Worker is a worker-src problem, and refused Wasm is a
// 'wasm-unsafe-eval' problem. One aggregate "startup failed" would tell a host
// neither. See src/startup.js and docs/csp.md.
//
// THE TREE GOES TO THE FRAME, NOT THE HOST. Once the host has handed this
// Worker its end of the private port (policy/attach-frame, see
// src/frame-protocol.js), an accepted tree is posted straight to the frame
// with the request's identity, and the host is told `rendered` only after the
// frame acknowledged that exact request. The host never holds the tree.
// Without a port (headless diagnostics and Node tests) the accepted reply
// carries the tree, but only for a request that declared `delivery: "host"`;
// a request declaring `delivery: "frame"` is refused until the port exists
// (src/policy-protocol.js#deliveryRefusal). The Worker never infers delivery.
//
// THERE IS NO FALLBACK. If the checker does not start, every request is
// refused with a bounded reason. The Worker does not fall back to the
// JavaScript checker, because that would bypass the acceptance authority.
//
// Termination is the only way to stop parse5 mid-parse, so the host holds the
// request timer and calls Worker.terminate() (src/policy-client.js). This
// entry therefore keeps no state that a lost reply could corrupt beyond the
// bounded startup queue, which is dropped with the Worker.

import manifest from "../dist/frame-manifest.js";
import { createLeanChecker } from "./lean-checker.js";
import { createPolicyDispatcher } from "./policy-dispatcher.js";
import { checkerBinary, createModule } from "./lean-module.js";

const dispatcher = createPolicyDispatcher({ post: message => self.postMessage(message), classes: manifest.classes });
self.addEventListener("message", event => dispatcher.receive(event.data, event.ports));
dispatcher.start();
(async () => {
  try {
    dispatcher.ready(await createLeanChecker({
      createModule, wasmBinary: await checkerBinary(),
      classes: manifest.classes, stylesheetHash: manifest.cssHash,
    }));
  } catch (error) {
    const detail = String(error && error.message ? error.message : error).slice(0, 300);
    dispatcher.fail({ code: "checker-init-failed", detail });
  }
})();
