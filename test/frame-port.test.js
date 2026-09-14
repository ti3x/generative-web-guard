// The private port, end to end in Node: the real Lean checker inside a Worker
// stand-in that mirrors src/policy-worker.js's port behaviour, a frame stand-in
// that installs a receiver exactly as src/frame.js does, and the real policy
// client wiring a MessageChannel between them on every session.
//
// What must hold: the host receives `rendered` with NO tree, the frame saw the
// exact tree Lean accepted, a reply that carries a tree while a port is
// installed is refused as a bypass AND ends the session, a frame refusal
// surfaces as a rejection, a replaced Worker gets a replaced port, and no
// request is served before the Worker confirms it holds the port: the client
// holds frame requests until policy/frame-attached, and the Worker refuses a
// `delivery: "frame"` request it cannot deliver over a port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicySession } from "../src/policy-client.js";
import { POLICY_DELIVERY, POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, deliveryRefusal } from "../src/policy-protocol.js";
import { isValidated, setClassAllowlist } from "../src/policy.js";
import { CLASSES, leanSkip, realChecker } from "./lean-support.js";
import { fakeFrame, portWorker } from "./port-support.js";

const skip = leanSkip();
setClassAllowlist(CLASSES);

function wire(checker, { workerMode = {}, frameMode = {}, timeouts = {} } = {}) {
  const frame = fakeFrame(frameMode);
  const workers = [];
  const client = createPolicySession({
    createWorker: () => { const w = portWorker(checker, workerMode); workers.push(w); return w; },
    classes: CLASSES,
    frame,
    timeouts: { startupMs: 200, requestMs: 200, ...timeouts },
  });
  return { frame, client, workers, close() { client.dispose(); frame.dispose(); } };
}

test("[R-CHECK-ACCEPTANCE] over the port the host receives rendered without a tree and the frame saw Lean's tree", { skip }, async () => {
  const checker = await realChecker();
  const w = wire(checker);
  const result = await w.client.preprocess(`<div class="card"><script>alert(1)</script><p onclick="x">hi</p></div>`);
  assert.equal(result.status, "rendered", JSON.stringify(result).slice(0, 200));
  assert.equal("tree" in result, false, "the host never receives the tree");
  assert.equal(result.acceptance.requestId, 1);
  assert.equal(w.client.frameAttached, true);
  assert.equal(w.frame.rendered.length, 1);
  assert.equal(w.frame.rendered[0].children[0].tag, "div");
  assert.ok(isValidated(w.frame.rendered[0]));
  assert.equal(w.client.stats.rendered, 1);
  w.close();
});

test("[R-CHECK-ACCEPTANCE] control: a Worker that hands the tree back while a port is installed is refused as a bypass and the session ends", { skip }, async () => {
  const checker = await realChecker();
  const terminated = [];
  const frame = fakeFrame();
  const workers = [];
  const client = createPolicySession({
    createWorker: () => { const w = portWorker(checker, { leakTree: true }); workers.push(w); return w; },
    classes: CLASSES,
    frame,
    timeouts: { startupMs: 200, requestMs: 200 },
    onTerminated: (reason) => terminated.push(reason.code),
  });
  const result = await client.preprocess(`<p class="card">x</p>`);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "authority-path-mismatch");
  assert.equal(frame.rendered.length, 0);
  // The requests were held until the port was confirmed, so this was not a
  // race: the Worker broke the protocol and the session is gone.
  assert.equal(workers[0].served[0].delivery, POLICY_DELIVERY.frame);
  assert.equal(client.alive, false, "a protocol violation terminates the session");
  assert.deepEqual(terminated, ["authority-path-mismatch"]);
  assert.equal(workers[0].terminated, true);
  client.dispose();
  frame.dispose();
});

// ---------------------------------------------------------------------------
// Delivery is declared by the host and checked by the Worker, never inferred
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] the Worker's delivery rule: frame without a port and host with a port are both refused", () => {
  assert.equal(deliveryRefusal({ delivery: "frame" }, true), null);
  assert.equal(deliveryRefusal({ delivery: "host" }, false), null);
  assert.equal(deliveryRefusal({ delivery: "frame" }, false).code, "frame-not-attached");
  assert.equal(deliveryRefusal({ delivery: "host" }, true).code, "delivery-mismatch");
  for (const bad of [{}, { delivery: "" }, { delivery: "FRAME" }, { delivery: 1 }, null, undefined]) {
    assert.equal(deliveryRefusal(bad, true).code, "delivery-unspecified");
    assert.equal(deliveryRefusal(bad, false).code, "delivery-unspecified");
  }
});

test("[R-CHECK-ACCEPTANCE] a frame session holds its requests until the Worker confirms the port, then renders them in order", { skip }, async () => {
  const checker = await realChecker();
  const w = wire(checker, { workerMode: { attachDelayMs: 40 }, timeouts: { requestMs: 1000, startupMs: 1000 } });
  const first = w.client.preprocess(`<p class="card">one</p>`);
  const second = w.client.preprocess(`<p class="card">two</p>`);
  assert.equal(w.client.awaitingCount, 2, "nothing is posted before policy/frame-attached");
  assert.equal(w.client.frameAttached, false);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.status), ["rendered", "rendered"], JSON.stringify(results).slice(0, 300));
  assert.equal(w.client.awaitingCount, 0);
  const worker = w.workers[0];
  assert.equal(worker.attachments, 1);
  assert.deepEqual(worker.served.map((m) => m.requestId), [1, 2], "held requests are released in order");
  assert.ok(worker.served.every((m) => m.delivery === POLICY_DELIVERY.frame));
  assert.equal(w.frame.rendered.length, 2);
  assert.equal(w.frame.rendered[1].children[0].children[0].text, "two");
  w.close();
});

test("[R-RT-LIMITS] a Worker that never confirms the port: the held request fails as frame-attach-timeout, no tree moves, and a replacement recovers", { skip }, async () => {
  const checker = await realChecker();
  let never = true;
  const frame = fakeFrame();
  const workers = [];
  const terminated = [];
  const client = createPolicySession({
    createWorker: () => { const w = portWorker(checker, { get neverAttach() { return never; } }); workers.push(w); return w; },
    classes: CLASSES,
    frame,
    timeouts: { startupMs: 80, requestMs: 80 },
    onTerminated: (reason) => terminated.push(reason.code),
  });
  const first = await client.preprocess(`<p class="card">one</p>`);
  assert.equal(first.status, "rejected");
  assert.equal(first.reason.code, "frame-attach-timeout");
  assert.equal(first.reason.limit, "requestMs");
  assert.equal(workers[0].served.length, 0, "the Worker never saw the request, so it could not answer with a tree");
  assert.equal(frame.rendered.length, 0);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(terminated, ["frame-attach-timeout"]);
  never = false;
  const second = await client.preprocess(`<p class="card">two</p>`);
  assert.equal(second.status, "rendered", JSON.stringify(second).slice(0, 200));
  assert.equal(frame.bootstraps, 2);
  assert.equal(frame.rendered.length, 1);
  client.dispose();
  frame.dispose();
});

test("[R-CHECK-ACCEPTANCE] control: a Worker without its port refuses a frame-delivery request instead of answering with a tree", { skip }, async () => {
  const checker = await realChecker();
  const worker = portWorker(checker, { neverAttach: true });
  const replies = [];
  worker.addEventListener("message", (event) => replies.push(event.data));
  const envelope = {
    protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.preprocess,
    instanceId: "i", sessionId: "s", generation: 0, requestId: 7,
    delivery: POLICY_DELIVERY.frame, html: `<p class="card">x</p>`, classes: CLASSES,
  };
  worker.postMessage(envelope);
  await new Promise((r) => setTimeout(r, 10));
  const reply = replies.find((m) => m.requestId === 7);
  assert.equal(reply.kind, POLICY_MESSAGE.refused);
  assert.equal(reply.reason.code, "frame-not-attached");
  assert.equal("tree" in reply, false);
  // And a request with no declared delivery is refused before any parsing.
  worker.postMessage({ ...envelope, requestId: 8, delivery: undefined });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies.find((m) => m.requestId === 8).reason.code, "delivery-unspecified");
  worker.terminate();
});

test("[R-CHECK-ACCEPTANCE] control: a Worker holding a port refuses a host-delivery request; a headless session declares host and gets its tree", { skip }, async () => {
  const checker = await realChecker();
  // Headless: no frame, so the client declares `host` and receives the tree.
  const workers = [];
  const headless = createPolicySession({
    createWorker: () => { const w = portWorker(checker); workers.push(w); return w; },
    classes: CLASSES,
    timeouts: { startupMs: 200, requestMs: 200 },
  });
  const diagnostic = await headless.preprocess(`<p class="card">x</p>`);
  assert.equal(diagnostic.status, "accepted");
  assert.ok(isValidated(diagnostic.tree));
  assert.equal(workers[0].served[0].delivery, POLICY_DELIVERY.host);
  headless.dispose();

  // Attached: the same Worker double now holds a port, so a `host` request is
  // refused rather than answered with a tree.
  const w = wire(checker);
  const rendered = await w.client.preprocess(`<p class="card">y</p>`);
  assert.equal(rendered.status, "rendered");
  const worker = w.workers[0];
  const replies = [];
  worker.addEventListener("message", (event) => replies.push(event.data));
  worker.postMessage({ ...worker.served[0], requestId: 99, delivery: POLICY_DELIVERY.host });
  await new Promise((r) => setTimeout(r, 10));
  const reply = replies.find((m) => m.requestId === 99);
  assert.equal(reply.kind, POLICY_MESSAGE.refused);
  assert.equal(reply.reason.code, "delivery-mismatch");
  assert.equal(w.frame.rendered.length, 1);
  w.close();
});

test("[R-CHECK-ACCEPTANCE] control: a rendered reply that smuggles a tree is refused", { skip }, async () => {
  const checker = await realChecker();
  const w = wire(checker, { workerMode: { renderedWithTree: true } });
  const result = await w.client.preprocess(`<p class="card">x</p>`);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "rendered-with-tree");
  w.close();
});

test("[R-FRAME-FIXED-POINT] a frame refusal over the port settles the request as a rejection, not a render", { skip }, async () => {
  const checker = await realChecker();
  const w = wire(checker, { frameMode: { refuse: true } });
  const result = await w.client.preprocess(`<p class="card">x</p>`);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "frame-refused");
  assert.equal(result.reason.detail, "frame declined");
  assert.equal(w.frame.rendered.length, 0);
  w.close();
});

test("[R-RT-LIMITS] a replaced Worker gets a replaced port: the frame is bootstrapped again and rendering resumes", { skip }, async () => {
  const checker = await realChecker();
  let hang = true;
  const frame = fakeFrame();
  const workers = [];
  const client = createPolicySession({
    createWorker: () => { const w = portWorker(checker, { get hang() { return hang; } }); workers.push(w); return w; },
    classes: CLASSES,
    frame,
    timeouts: { startupMs: 80, requestMs: 80 },
  });
  const first = await client.preprocess(`<p class="card">one</p>`);
  assert.equal(first.status, "rejected");
  assert.equal(first.reason.code, "timeout");
  assert.equal(workers[0].terminated, true);
  assert.equal(client.frameAttached, false, "the dead session's port is gone");
  hang = false;
  const second = await client.preprocess(`<p class="card">two</p>`);
  assert.equal(second.status, "rendered", JSON.stringify(second).slice(0, 200));
  assert.equal(workers.length, 2);
  assert.equal(frame.bootstraps, 2, "the frame was handed a fresh port for the fresh Worker");
  assert.equal(frame.rendered.length, 1);
  client.dispose();
  frame.dispose();
});
