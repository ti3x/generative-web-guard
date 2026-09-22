// The private port between the policy Worker and the sandboxed frame.
//
// Phase 4 made Lean the acceptance authority but left the HOST holding the
// accepted tree between acceptance and rendering: the policy Worker returned
// the tree, the host stored it against a one-time record, and the frame's
// render path claimed the record from the host. With this protocol the tree
// never stops at the host at all. The host creates a MessageChannel, hands one
// end to the policy Worker and the other to the frame in a one-time parent
// bootstrap, and from then on:
//
//   * the policy Worker sends the exact tree Lean accepted, with the request's
//     identity, over the port (`frame/render`);
//   * the frame renders ONLY what arrives over that port, acknowledges it on
//     the same port (`frame/rendered` / `frame/refused`), and refuses `render`
//     from its parent;
//   * every message carries the protocol version, instance and session
//     identity, generation, request id and a per-port sequence number, so a
//     stale, duplicate, replayed or foreign message is dropped unanswered.
//
// What the port provides is DELIVERY PROVENANCE: a tree in the frame came from
// the policy Worker's acceptance path, because nothing else can post to the
// port. It is not a cryptographic certificate, and the host is still trusted
// glue: it wires the channel and could wire it wrongly. What it cannot do any
// more is supply a tree.

export const FRAME_PROTOCOL_VERSION = 1;

export const FRAME_MESSAGE = Object.freeze({
  // parent -> frame, via postMessage with the MessagePort in `ports[0]`.
  // Accepted again only to REPLACE a port (the policy Worker was replaced); a
  // bootstrap never carries a tree and never reopens the parent route.
  bootstrap: "frame/bootstrap",
  // frame -> parent, once a port is installed.
  bound: "frame/bound",
  // policy Worker -> frame, over the port.
  render: "frame/render",
  // frame -> policy Worker, over the port.
  rendered: "frame/rendered",
  refused: "frame/refused",
});

const MAX_REASON = 300;

function isId(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function isCount(value) { return Number.isInteger(value) && value >= 0; }

/** Version and identity fields shared by every message on the port. */
export function isFrameIdentity(message, expect = {}) {
  if (!message || typeof message !== "object") return false;
  if (message.protocol !== FRAME_PROTOCOL_VERSION) return false;
  if (!isId(message.instanceId) || !isId(message.sessionId)) return false;
  if (expect.instanceId !== undefined && message.instanceId !== expect.instanceId) return false;
  if (expect.sessionId !== undefined && message.sessionId !== expect.sessionId) return false;
  return true;
}

/** A render command as the frame must see it before it looks at the tree. */
export function isFrameRender(message, expect = {}) {
  if (!isFrameIdentity(message, expect)) return false;
  if (message.kind !== FRAME_MESSAGE.render) return false;
  if (!isCount(message.generation) || !isCount(message.requestId) || !isCount(message.seq)) return false;
  if (message.tree === null || typeof message.tree !== "object") return false;
  return true;
}

/** An acknowledgement as the policy Worker must see it. */
export function isFrameAck(message, expect = {}) {
  if (!isFrameIdentity(message, expect)) return false;
  if (message.kind !== FRAME_MESSAGE.rendered && message.kind !== FRAME_MESSAGE.refused) return false;
  if (!isCount(message.seq) || !isCount(message.generation) || !isCount(message.requestId)) return false;
  return true;
}

export function frameEnvelope(ids, kind, body = {}) {
  return { protocol: FRAME_PROTOCOL_VERSION, kind, instanceId: ids.instanceId, sessionId: ids.sessionId, ...body };
}

/** Reasons cross the port as bounded plain text, never as error objects. */
export function boundedReason(value) {
  return typeof value === "string" ? value.slice(0, MAX_REASON) : undefined;
}
