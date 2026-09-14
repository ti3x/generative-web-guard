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
// carries the tree as before.
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
import { createPolicyCore, handlePolicyRequest } from "./policy-core.js";
import { createLeanChecker } from "./lean-checker.js";
import { createFrameSender } from "./frame-channel.js";
import { checkerBinary, createModule } from "./lean-module.js";
import {
  POLICY_MESSAGE,
  POLICY_PROTOCOL_VERSION,
  POLICY_STARTUP_QUEUE_MAX,
  policyRejection,
  replyEnvelope,
} from "./policy-protocol.js";

/** Null until the authority exists. No core means no acceptance, ever. */
let core = null;
/** A bounded reason once startup has failed. Never cleared. */
let failure = null;
/** Requests that arrived while the checker was still starting. */
const queued = [];
/** The private port to the frame, once the host has handed it over. */
let frameSender = null;

function post(message) {
  self.postMessage(message);
}

function refuse(message, reason) {
  post(replyEnvelope(message, POLICY_MESSAGE.result, policyRejection(reason.code, reason)));
}

function attachFrame(message, ports) {
  const port = ports && ports[0];
  const valid = message.protocol === POLICY_PROTOCOL_VERSION
    && typeof message.instanceId === "string" && typeof message.sessionId === "string" && !!port;
  if (!valid) {
    return post({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.refused, reason: { code: "bad-attach" } });
  }
  if (frameSender) frameSender.dispose();
  frameSender = createFrameSender(port, { instanceId: message.instanceId, sessionId: message.sessionId });
  post({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.frameAttached, instanceId: message.instanceId, sessionId: message.sessionId });
}

function serve(message) {
  let reply;
  try {
    reply = handlePolicyRequest(core, message);
  } catch (error) {
    // Last resort: a fault in envelope handling itself must still settle the
    // host's request instead of leaving it to the watchdog.
    const text = error && typeof error.message === "string" ? error.message : String(error);
    reply = {
      protocol: POLICY_PROTOCOL_VERSION,
      kind: POLICY_MESSAGE.refused,
      instanceId: message?.instanceId,
      sessionId: message?.sessionId,
      generation: message?.generation,
      requestId: message?.requestId,
      reason: { code: "worker-fault", detail: String(text).slice(0, 200) },
    };
  }
  if (frameSender && reply.kind === POLICY_MESSAGE.result && reply.status === "accepted") {
    // Deliver Lean's tree to the frame ourselves and answer the host only with
    // the frame's verdict on this exact request. The reply to the host carries
    // no tree: there is nothing for it to render with.
    const { tree, ...rest } = reply;
    const sender = frameSender;
    sender.render(tree, { generation: message.generation, requestId: message.requestId }).then((ack) => {
      post(ack.ok
        ? { ...rest, status: "rendered", stats: { ...rest.stats, frameTreeMessages: sender.stats.sent } }
        : replyEnvelope(message, POLICY_MESSAGE.result, policyRejection(ack.reason.code, ack.reason)));
    });
    return;
  }
  post(reply);
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.kind === POLICY_MESSAGE.attachFrame) return attachFrame(message, event.ports);
  if (failure) return refuse(message, failure);
  if (core) return serve(message);
  // The checker is still starting. Hold a bounded number of requests rather
  // than dropping them (the host would see a timeout and learn nothing) or
  // accepting them without an authority (which cannot happen at all).
  if (queued.length >= POLICY_STARTUP_QUEUE_MAX) {
    return refuse(message, { code: "startup-queue-full", detail: `more than ${POLICY_STARTUP_QUEUE_MAX} requests before the checker was ready` });
  }
  queued.push(message);
});

// The channel works. Say so now, so a refused blob: Worker is distinguishable
// from a checker that will not compile.
post({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready });

// ---------------------------------------------------------------------------
// wasm-init stage: instantiate, seal, verify identity.
//
// The class allowlist and the stylesheet identity come from the build-time
// frame manifest, which the bundler inlines. They are sealed into the instance
// here, BEFORE any document is checked, and no message can change them.
// ---------------------------------------------------------------------------
(async () => {
  try {
    const checker = await createLeanChecker({
      createModule,
      wasmBinary: await checkerBinary(),
      classes: manifest.classes,
      stylesheetHash: manifest.cssHash,
    });
    core = createPolicyCore({ checker, classes: manifest.classes });
    post({
      protocol: POLICY_PROTOCOL_VERSION,
      kind: POLICY_MESSAGE.checkerReady,
      checker: checker.identity,
    });
  } catch (error) {
    const detail = error && typeof error.message === "string" ? error.message : String(error);
    // Reported as `checker-init-failed` with the bounded detail. The HOST
    // classifies it (src/policy-client.js): the most common real cause is a
    // host policy without 'wasm-unsafe-eval', because a blob: Worker inherits
    // the document policy and the checker's own WebAssembly.instantiate is
    // then refused with a CompileError. Classifying here would pull the whole
    // startup-diagnostics module -- hint strings and the blob: Worker helper
    // included -- into this payload, and this payload stays minimal.
    failure = { code: "checker-init-failed", detail: detail.slice(0, 300) };
    post({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.failed, reason: failure });
  }
  // Settle whatever waited, in arrival order, with the outcome that applies.
  while (queued.length > 0) {
    const message = queued.shift();
    if (failure) refuse(message, failure);
    else serve(message);
  }
})();
