// The private port between the policy Worker and the frame, exercised end to
// end on Node's MessageChannel: the sender settles exactly once per render,
// the receiver renders only well-formed commands for its own identity with a
// strictly increasing sequence, and everything else is dropped unanswered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameReceiver, createFrameSender } from "../src/frame-channel.js";
import { FRAME_MESSAGE, FRAME_PROTOCOL_VERSION, frameEnvelope } from "../src/frame-protocol.js";

const IDS = { instanceId: "inst-1", sessionId: "sess-1" };
const TREE = { kind: "root", children: [] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function pair({ onRender = () => ({ ok: true }), receiverIds = IDS, senderIds = IDS, timeoutMs = null } = {}) {
  const channel = new MessageChannel();
  const receiver = createFrameReceiver(channel.port2, { ...receiverIds, onRender });
  const sender = createFrameSender(channel.port1, { ...senderIds, timeoutMs });
  return { channel, receiver, sender, close() { sender.dispose(); receiver.dispose(); } };
}

test("[R-FRAME-MESSAGE-SCHEMA] a render over the port is acknowledged once and the receiver saw the exact tree", async () => {
  const seen = [];
  const p = pair({ onRender: (tree) => { seen.push(tree); return { ok: true }; } });
  const result = await p.sender.render(TREE, { generation: 1, requestId: 7 });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [TREE]);
  assert.equal(p.sender.pendingCount, 0);
  assert.deepEqual(p.receiver.stats, { rendered: 1, refused: 0, ignored: 0 });
  p.close();
});

test("[R-FRAME-FIXED-POINT] a tree the receiver refuses settles the sender with frame-refused and the reason", async () => {
  const p = pair({ onRender: () => ({ ok: false, reason: "tree is not a validated fixed point" }) });
  const result = await p.sender.render(TREE, { generation: 1, requestId: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, "frame-refused");
  assert.equal(result.reason.detail, "tree is not a validated fixed point");
  assert.deepEqual(p.receiver.stats, { rendered: 0, refused: 1, ignored: 0 });
  p.close();
});

test("[R-FRAME-MESSAGE-SCHEMA] a command for another instance or session is dropped, not answered", async () => {
  const p = pair({ senderIds: { instanceId: "other-instance", sessionId: "sess-1" }, timeoutMs: 40 });
  const result = await p.sender.render(TREE, { generation: 1, requestId: 1 });
  assert.equal(result.reason.code, "frame-ack-timeout");
  assert.deepEqual(p.receiver.stats, { rendered: 0, refused: 0, ignored: 1 });
  p.close();
});

test("[R-FRAME-MESSAGE-SCHEMA] a stale or duplicate sequence number is dropped and cannot elicit a second acknowledgement", async () => {
  const p = pair();
  await p.sender.render(TREE, { generation: 1, requestId: 1 }); // seq 1, answered
  // Replay seq 1 and post a seq 0 directly, bypassing the sender.
  p.channel.port1.postMessage(frameEnvelope(IDS, FRAME_MESSAGE.render, { generation: 1, requestId: 1, seq: 1, tree: TREE }));
  p.channel.port1.postMessage(frameEnvelope(IDS, FRAME_MESSAGE.render, { generation: 1, requestId: 1, seq: 0, tree: TREE }));
  await tick();
  assert.deepEqual(p.receiver.stats, { rendered: 1, refused: 0, ignored: 2 });
  assert.equal(p.sender.stats.ignored, 0, "no acknowledgement was produced for the replays");
  p.close();
});

test("[R-FRAME-MESSAGE-SCHEMA] malformed, foreign and unknown acknowledgements are ignored by the sender", async () => {
  const p = pair();
  const inFlight = p.sender.render(TREE, { generation: 1, requestId: 1 }); // seq 1, answered by the receiver
  p.channel.port2.postMessage({ protocol: FRAME_PROTOCOL_VERSION, kind: FRAME_MESSAGE.rendered, seq: 1 }); // no identity
  p.channel.port2.postMessage(frameEnvelope(IDS, FRAME_MESSAGE.rendered, { seq: 42 })); // unknown seq
  p.channel.port2.postMessage(frameEnvelope({ instanceId: "x", sessionId: "y" }, FRAME_MESSAGE.rendered, { seq: 1 })); // foreign
  p.channel.port2.postMessage("rendered");
  const result = await inFlight;
  assert.deepEqual(result, { ok: true });
  await tick();
  assert.equal(p.sender.stats.ignored, 4, JSON.stringify(p.sender.stats));
  p.close();
});

test("[R-RT-LIMITS] disposing the sender settles every pending render as frame-port-closed, exactly once", async () => {
  const channel = new MessageChannel(); // nobody listens on port2: acknowledgements never come
  const sender = createFrameSender(channel.port1, IDS);
  let settled = 0;
  const a = sender.render(TREE, { generation: 1, requestId: 1 }).then((r) => { settled += 1; return r; });
  const b = sender.render(TREE, { generation: 1, requestId: 2 }).then((r) => { settled += 1; return r; });
  sender.dispose();
  sender.dispose(); // idempotent
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map((r) => r.reason.code), ["frame-port-closed", "frame-port-closed"]);
  assert.equal(settled, 2);
  const late = await sender.render(TREE, { generation: 1, requestId: 3 });
  assert.equal(late.reason.code, "frame-port-closed");
  channel.port2.close();
});

test("[R-RT-LIMITS] a sender deadline settles a render whose acknowledgement never comes", async () => {
  const channel = new MessageChannel();
  const sender = createFrameSender(channel.port1, { ...IDS, timeoutMs: 30 });
  const result = await sender.render(TREE, { generation: 1, requestId: 1 });
  assert.equal(result.reason.code, "frame-ack-timeout");
  sender.dispose();
  channel.port2.close();
});

test("[R-FRAME-FIXED-POINT] a throwing render is answered as a refusal and does not take the receiver down", async () => {
  let calls = 0;
  const p = pair({ onRender: () => { calls += 1; if (calls === 1) throw new Error("renderer exploded"); return { ok: true }; } });
  const first = await p.sender.render(TREE, { generation: 1, requestId: 1 });
  assert.equal(first.reason.code, "frame-refused");
  assert.equal(first.reason.detail, "renderer exploded");
  const second = await p.sender.render(TREE, { generation: 1, requestId: 2 });
  assert.deepEqual(second, { ok: true });
  assert.equal(p.receiver.lastSeq, 2);
  p.close();
});
