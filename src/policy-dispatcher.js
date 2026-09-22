// The production Worker's transport state, shared with deterministic tests.
// Dependencies are constructor-only trusted glue, never message fields or CDN
// exports. Startup and every serve path still require the Lean authority.
import { createPolicyCore, handlePolicyRequest } from "./policy-core.js";
import { createFrameSender } from "./frame-channel.js";
import {
  POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, POLICY_STARTUP_QUEUE_MAX,
  deliveryRefusal, isPolicyEnvelope, policyRejection, replyEnvelope,
} from "./policy-protocol.js";

export function createPolicyDispatcher({ post, classes }) {
  let core = null, failure = null, frameSender = null, closed = false;
  const queued = [];
  const send = message => { if (!closed) post(message); };
  const refuse = (message, reason) => send(replyEnvelope(message, POLICY_MESSAGE.result, policyRejection(reason.code, reason)));

  function serve(message) {
    const delivery = isPolicyEnvelope(message) ? deliveryRefusal(message, frameSender !== null) : null;
    if (delivery) return refuse(message, delivery);
    const reply = handlePolicyRequest(core, message);
    if (frameSender && reply.kind === POLICY_MESSAGE.result && reply.status === "accepted") {
      const { tree, ...rest } = reply;
      const sender = frameSender;
      sender.render(tree, { generation: message.generation, requestId: message.requestId }).then(ack => {
        if (closed || sender !== frameSender) return;
        send(ack.ok
          ? { ...rest, status: "rendered", stats: { ...rest.stats, frameTreeMessages: sender.stats.sent } }
          : replyEnvelope(message, POLICY_MESSAGE.result, policyRejection(ack.reason.code, ack.reason)));
      });
      return;
    }
    send(reply);
  }

  function drain() {
    while (!closed && queued.length) {
      const message = queued.shift();
      if (failure) refuse(message, failure); else serve(message);
    }
  }

  return {
    start() { send({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready }); },
    ready(checker) {
      if (closed) { checker.dispose(); return; }
      core = createPolicyCore({ checker, classes });
      send({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.checkerReady, checker: checker.identity });
      drain();
    },
    fail(reason) {
      failure = reason;
      send({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.failed, reason });
      drain();
    },
    receive(message, ports = []) {
      if (closed) return;
      if (message?.kind === POLICY_MESSAGE.attachFrame) {
        const port = ports[0];
        if (message.protocol !== POLICY_PROTOCOL_VERSION || typeof message.instanceId !== "string"
            || typeof message.sessionId !== "string" || !port) {
          return send({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.refused, reason: { code: "bad-attach" } });
        }
        frameSender?.dispose();
        frameSender = createFrameSender(port, { instanceId: message.instanceId, sessionId: message.sessionId });
        send({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.frameAttached, instanceId: message.instanceId, sessionId: message.sessionId });
        return;
      }
      if (failure) return refuse(message, failure);
      if (core) return serve(message);
      if (queued.length >= POLICY_STARTUP_QUEUE_MAX) return refuse(message, { code: "startup-queue-full", detail: `more than ${POLICY_STARTUP_QUEUE_MAX} requests before the checker was ready` });
      queued.push(message);
    },
    dispose() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      frameSender?.dispose();
      core?.checker.dispose();
    },
    get pendingCount() { return queued.length + (frameSender?.pendingCount ?? 0); },
  };
}
