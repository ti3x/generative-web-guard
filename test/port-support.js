// Stand-ins for the two ends of the private port, shared by the tests that
// wire the real policy client to the real Lean checker in Node.
import { createPolicyCore, handlePolicyRequest } from "../src/policy-core.js";
import { createFrameReceiver, createFrameSender } from "../src/frame-channel.js";
import { POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, deliveryRefusal, replyEnvelope } from "../src/policy-protocol.js";
import { isTreeShaped } from "../src/tree.js";
import { CLASSES } from "./lean-support.js";

// Mirrors the entry point: attach installs a sender on the transferred port;
// an accepted result goes to the frame and the host hears `rendered`. The
// same delivery rule as src/policy-worker.js applies before any parsing.
//
// modes: hang (never answer), leakTree / renderedWithTree (bypass controls),
// noCheckerReady (stalled wasm-init), attachDelayMs (confirm the port late),
// neverAttach (install the port but never confirm it), skipDeliveryCheck
// (a Worker that ignores the declared delivery: the client must still refuse).
export function portWorker(checker, mode = {}) {
  const core = createPolicyCore({ classes: CLASSES, checker });
  const listeners = new Set();
  let sender = null;
  const emit = (data) => { for (const fn of [...listeners]) fn({ data }); };
  const worker = {
    terminated: false,
    attachments: 0,
    served: [], // preprocess envelopes this Worker received, in order
    addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    terminate() { worker.terminated = true; listeners.clear(); if (sender) sender.dispose(); },
    postMessage(request, transfer) {
      if (request.kind === POLICY_MESSAGE.attachFrame) {
        worker.attachments += 1;
        if (sender) sender.dispose();
        sender = createFrameSender(transfer[0], { instanceId: request.instanceId, sessionId: request.sessionId });
        if (mode.neverAttach) return;
        const confirm = () => {
          if (worker.terminated) return;
          emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.frameAttached, instanceId: request.instanceId, sessionId: request.sessionId });
        };
        if (mode.attachDelayMs) setTimeout(confirm, mode.attachDelayMs); else confirm();
        return;
      }
      worker.served.push(request);
      if (mode.hang) return;
      setTimeout(async () => {
        if (worker.terminated) return;
        const refusal = mode.skipDeliveryCheck ? null : deliveryRefusal(request, sender !== null);
        if (refusal) return emit(replyEnvelope(request, POLICY_MESSAGE.refused, { reason: refusal }));
        const reply = handlePolicyRequest(core, request);
        if (reply.kind === POLICY_MESSAGE.result && reply.status === "accepted") {
          if (mode.leakTree || sender === null) return emit(reply); // headless, or a bypass: the tree comes back to the host
          const { tree, ...rest } = reply;
          const ack = await sender.render(tree, { generation: request.generation, requestId: request.requestId });
          if (worker.terminated) return;
          if (mode.renderedWithTree) return emit({ ...rest, status: "rendered", tree });
          return emit(ack.ok ? { ...rest, status: "rendered" } : replyEnvelope(request, POLICY_MESSAGE.result, { status: "rejected", reason: ack.reason }));
        }
        emit(reply);
      }, 0);
    },
  };
  setTimeout(() => {
    if (worker.terminated) return;
    emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready });
    if (mode.noCheckerReady) return; // a stalled wasm-init stage, as the host sees it
    emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.checkerReady, checker: checker.identity });
  }, 0);
  return worker;
}

// Mirrors src/frame.js: a bootstrap installs a receiver whose render is the
// frame's own re-validation.
export function fakeFrame({ refuse = false } = {}) {
  const frame = { rendered: [], bootstraps: 0, receiver: null };
  frame.attachPort = (port, ids) => {
    frame.bootstraps += 1;
    if (frame.receiver) frame.receiver.dispose();
    frame.receiver = createFrameReceiver(port, {
      ...ids,
      onRender: (tree) => {
        if (refuse) return { ok: false, reason: "frame declined" };
        if (!isTreeShaped(tree)) return { ok: false, reason: "malformed renderer tree" };
        frame.rendered.push(tree);
        return { ok: true };
      },
    });
    return Promise.resolve(true);
  };
  frame.dispose = () => { if (frame.receiver) frame.receiver.dispose(); };
  return frame;
}
