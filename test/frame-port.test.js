// The private port, end to end in Node: the real Lean checker inside a Worker
// stand-in that mirrors src/policy-worker.js's port behaviour, a frame stand-in
// that installs a receiver exactly as src/frame.js does, and the real policy
// client wiring a MessageChannel between them on every session.
//
// What must hold: the host receives `rendered` with NO tree, the frame saw the
// exact tree Lean accepted, a reply that carries a tree while a port is
// installed is refused as a bypass, a frame refusal surfaces as a rejection,
// and a replaced Worker gets a replaced port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicySession } from "../src/policy-client.js";
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

test("[R-CHECK-ACCEPTANCE] control: a Worker that hands the tree back while a port is installed is refused as a bypass", { skip }, async () => {
  const checker = await realChecker();
  const w = wire(checker, { workerMode: { leakTree: true } });
  const result = await w.client.preprocess(`<p class="card">x</p>`);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "authority-path-mismatch");
  assert.equal(w.frame.rendered.length, 0);
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
