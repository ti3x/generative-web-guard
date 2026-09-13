// The two ends of the private port (src/frame-protocol.js), environment-neutral
// so both run on Node's MessageChannel in tests as well as in the browser.
//
//   createFrameSender    lives in the policy Worker. It posts the tree Lean
//                        accepted and settles exactly once per render: with the
//                        frame's acknowledgement, with a refusal when the port
//                        is gone, or with a timeout when a caller asked for one.
//   createFrameReceiver  lives in the frame. It renders only a well-formed
//                        command for its own instance and session whose
//                        sequence number is strictly newer than the last one
//                        answered, answers on the same port, and counts what it
//                        dropped. A stale or duplicate command is not answered
//                        at all, so a replay cannot elicit a second ack.
//
// Neither end trusts the other's message shape; both validate before reading.

import { FRAME_MESSAGE, boundedReason, frameEnvelope, isFrameAck, isFrameRender } from "./frame-protocol.js";

// Setting onmessage starts a port in browsers; Node wants start() called.
// An open port keeps a Node process alive until dispose() closes it, which is
// what every caller and test must do.
function detach(port) {
  if (typeof port.start === "function") port.start();
}

/**
 * @param {MessagePort} port
 * @param {{instanceId:string, sessionId:string, timeoutMs?:number|null}} options
 *        `timeoutMs` is optional because the host's request budget already
 *        bounds the whole round trip and terminates the Worker on expiry; a
 *        sender deadline is for callers with no such budget.
 */
export function createFrameSender(port, { instanceId, sessionId, timeoutMs = null }) {
  const ids = { instanceId, sessionId };
  const pending = new Map(); // seq -> { resolve, timer }
  let seq = 0;
  let closed = false;
  const stats = { sent: 0, rendered: 0, refused: 0, ignored: 0 };

  function settle(s, result) {
    const entry = pending.get(s);
    if (!entry) return;
    pending.delete(s);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
  }

  port.onmessage = (event) => {
    const message = event.data;
    if (!isFrameAck(message, ids) || !pending.has(message.seq)) { stats.ignored += 1; return; }
    if (message.kind === FRAME_MESSAGE.rendered) { stats.rendered += 1; settle(message.seq, { ok: true }); return; }
    stats.refused += 1;
    settle(message.seq, { ok: false, reason: { code: "frame-refused", detail: boundedReason(message.reason) } });
  };
  detach(port);

  return {
    /** Post one accepted tree. Always settles, exactly once. */
    render(tree, { generation, requestId }) {
      if (closed) return Promise.resolve({ ok: false, reason: { code: "frame-port-closed" } });
      const mySeq = ++seq;
      stats.sent += 1;
      return new Promise((resolve) => {
        const timer = timeoutMs === null ? null : setTimeout(() => {
          settle(mySeq, { ok: false, reason: { code: "frame-ack-timeout", limit: "timeoutMs", limitValue: timeoutMs } });
        }, timeoutMs);
        pending.set(mySeq, { resolve, timer });
        try {
          port.postMessage(frameEnvelope(ids, FRAME_MESSAGE.render, { generation, requestId, seq: mySeq, tree }));
        } catch (error) {
          settle(mySeq, { ok: false, reason: { code: "frame-post-failed", detail: boundedReason(error && error.message) } });
        }
      });
    },
    /** Settle everything pending as closed and release the port. Idempotent. */
    dispose() {
      if (closed) return;
      closed = true;
      for (const s of [...pending.keys()]) settle(s, { ok: false, reason: { code: "frame-port-closed" } });
      port.onmessage = null;
      try { port.close(); } catch { /* already closed */ }
    },
    get pendingCount() { return pending.size; },
    get stats() { return { ...stats }; },
  };
}

/**
 * @param {MessagePort} port
 * @param {{instanceId:string, sessionId:string,
 *          onRender:(tree:object)=>{ok:boolean, reason?:string}}} options
 */
export function createFrameReceiver(port, { instanceId, sessionId, onRender }) {
  const ids = { instanceId, sessionId };
  let lastSeq = 0;
  let closed = false;
  const stats = { rendered: 0, refused: 0, ignored: 0 };

  port.onmessage = (event) => {
    const message = event.data;
    if (!isFrameRender(message, ids) || message.seq <= lastSeq) { stats.ignored += 1; return; }
    lastSeq = message.seq;
    let result;
    try {
      result = onRender(message.tree);
    } catch (error) {
      result = { ok: false, reason: boundedReason(error && error.message) ?? "render failed" };
    }
    const ack = { generation: message.generation, requestId: message.requestId, seq: message.seq };
    if (result && result.ok === true) {
      stats.rendered += 1;
      port.postMessage(frameEnvelope(ids, FRAME_MESSAGE.rendered, ack));
    } else {
      stats.refused += 1;
      port.postMessage(frameEnvelope(ids, FRAME_MESSAGE.refused, { ...ack, reason: boundedReason(result && result.reason) ?? "refused" }));
    }
  };
  detach(port);

  return {
    dispose() {
      if (closed) return;
      closed = true;
      port.onmessage = null;
      try { port.close(); } catch { /* already closed */ }
    },
    get lastSeq() { return lastSeq; },
    get stats() { return { ...stats }; },
  };
}
