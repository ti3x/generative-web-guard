// The policy Worker: bounded parse5 preprocessing, candidate construction and
// LEAN/WASM ACCEPTANCE behind a versioned message protocol with
// instance/session identity, generation and request id.
//
// The authority here is the real shipped checker, instantiated from
// lean/wasm/dist, because the point of this phase is that the integrated path
// actually depends on Lean. The negative controls -- a checker that rejects a
// benign document, a missing one, a corrupt one, a stalled one, a spoofed or
// replayed reply, and a candidate builder forced to emit a forbidden tree --
// are in test/lean-authority.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPolicyCore, handlePolicyRequest, LEAN_AUTHORITY } from "../src/policy-core.js";
import { createPolicySession } from "../src/policy-client.js";
import { isAcceptanceToken } from "../src/acceptance.js";
import { LEAN_CHECKER_VERSION } from "../src/lean-abi.js";
import {
  POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, PREPROCESS_LIMITS, boundDiagnostics, utf8ByteLength,
} from "../src/policy-protocol.js";
import { CLASSES, leanSkip, realChecker } from "./lean-support.js";

const skip = leanSkip();
const deep = () => "<div>".repeat(5000) + "x" + "</div>".repeat(5000);

// The real checker, shared by the tests in this file.
let checker = null;
async function authority() {
  if (checker === null) checker = await realChecker();
  return checker;
}

// A Worker stand-in that runs the real Worker entry logic in-process. `mode`
// injects the failure shapes the client has to survive.
function fakeWorker(mode = {}) {
  const core = createPolicyCore({ classes: CLASSES, checker: mode.checker ?? checker, candidateBuilder: mode.candidateBuilder });
  const listeners = { message: new Set(), error: new Set() };
  const worker = {
    posted: [],
    terminated: false,
    addEventListener(type, fn) { listeners[type]?.add(fn); },
    // The real entry point posts policy/ready as soon as it loads; the client
    // treats that as the channel-handshake stage completing, so the stand-in
    // has to do it too. `noReady` withholds it to exercise the handshake
    // timeout.
    emitReady() {
      if (mode.noReady) return;
      for (const fn of [...listeners.message]) fn({ data: { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready } });
      // The real entry point then instantiates the Lean authority and posts
      // policy/checker-ready. `noCheckerReady` withholds it, which is what a
      // stalled wasm-init looks like to the host.
      if (mode.noCheckerReady) return;
      const identity = (mode.checker ?? checker)?.identity ?? null;
      for (const fn of [...listeners.message]) {
        fn({ data: { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.checkerReady, checker: mode.checkerIdentity ?? identity } });
      }
    },
    emitFailed(reason) {
      for (const fn of [...listeners.message]) {
        fn({ data: { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.failed, reason } });
      }
    },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    terminate() { worker.terminated = true; listeners.message.clear(); },
    emitError(message) { for (const fn of [...listeners.error]) fn({ message }); },
    postMessage(request) {
      worker.posted.push(request);
      if (mode.hang) return;
      setTimeout(() => {
        if (worker.terminated) return; // a terminated Worker cannot answer
        let reply = handlePolicyRequest(core, request);
        if (mode.mangle) reply = mode.mangle(reply);
        for (const fn of [...listeners.message]) fn({ data: reply });
        if (mode.duplicate) for (const fn of [...listeners.message]) fn({ data: reply });
      }, 0);
    },
  };
  setTimeout(() => { if (!worker.terminated) worker.emitReady(); }, 0);
  return worker;
}

function session(mode = {}, options = {}) {
  const worker = fakeWorker(mode);
  const client = createPolicySession({
    createWorker: () => worker,
    classes: CLASSES,
    timeouts: { startupMs: 60, requestMs: 60 },
    ...options,
  });
  return { worker, client };
}

// --- the happy path and the envelope ---------------------------------------

test("[R-CHECK-ACCEPTANCE] an accepted document comes back from the Lean authority with the request's identity, a one-time acceptance and bounded diagnostics", { skip }, async () => {
  await authority();
  const { worker, client } = session();
  const result = await client.preprocess(`<div class="card"><script>alert(1)</script><p onclick="x">hi</p></div>`);
  assert.equal(result.status, "accepted");
  // Lean accepted it, and the reply says so honestly. There is no code path
  // that reports this authority without the Lean verdict behind it.
  assert.equal(result.authority, LEAN_AUTHORITY);
  assert.equal(result.stats.checkerVersion, LEAN_CHECKER_VERSION);
  // The one-time record that authorizes a frame commit.
  assert.ok(isAcceptanceToken(result.acceptance), JSON.stringify(result.acceptance));
  assert.equal(result.acceptance.authority, LEAN_AUTHORITY);
  assert.equal(result.acceptance.checkerVersion, LEAN_CHECKER_VERSION);
  assert.equal(result.acceptance.requestId, 1);
  assert.equal(result.acceptance.instanceId, client.instanceId);
  assert.deepEqual(result.tree.children[0].tag, "div");
  assert.equal(result.requestId, 1);
  assert.equal(result.generation, 0);
  assert.equal(result.diagnostics.total, 2);
  assert.equal(result.diagnostics.truncated, false);
  assert.ok(result.stats.candidateTransportUtf8Bytes > 0);

  const sent = worker.posted[0];
  assert.equal(sent.protocol, POLICY_PROTOCOL_VERSION);
  assert.equal(sent.kind, POLICY_MESSAGE.preprocess);
  assert.equal(sent.instanceId, client.instanceId);
  assert.equal(typeof sent.sessionId, "string");
  assert.equal(sent.requestId, 1);
  assert.equal(sent.generation, 0);
  // The trusted class allowlist is sent once per session, not per document.
  assert.deepEqual(sent.classes, CLASSES);
  await client.preprocess("<p>second</p>");
  assert.equal(worker.posted[1].classes, undefined);
  client.dispose();
});

test("[R-LIMIT-TREE] hostile markup is rejected inside the Worker with a structured reason", { skip }, async () => {
  await authority();
  const { client } = session();
  const result = await client.preprocess(deep());
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "raw-depth-exceeded");
  assert.equal(result.reason.limit, "maxRawDepth");
  assert.equal(result.reason.limitValue, PREPROCESS_LIMITS.maxRawDepth);
  client.dispose();
});

test("[R-LIMIT-TREE] diagnostics are bounded by record count and by encoded size", { skip }, async () => {
  await authority();
  const { client } = session();
  const result = await client.preprocess("<p onclick=1>t</p>".repeat(250));
  assert.equal(result.status, "accepted");
  const { records, total, truncated, bytes } = result.diagnostics;
  assert.equal(total, 250);
  assert.equal(truncated, true);
  assert.ok(records.length <= PREPROCESS_LIMITS.maxDiagnosticRecords);
  assert.ok(bytes <= PREPROCESS_LIMITS.maxDiagnosticsUtf8Bytes);
  // `bytes` is the summed encoded size of the records that were kept.
  const summed = records.reduce((total, record) => total + utf8ByteLength(JSON.stringify(record)), 0);
  assert.equal(bytes, summed);
  client.dispose();
});

// --- protocol refusals ------------------------------------------------------

test("[R-FRAME-MESSAGE-SCHEMA] the Worker refuses malformed envelopes and unknown requests", { skip }, async () => {
  const core = createPolicyCore({ classes: CLASSES, checker: await authority() });
  const base = {
    protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.preprocess,
    instanceId: "i", sessionId: "s", generation: 0, requestId: 1, html: "<p>x</p>",
  };
  assert.equal(handlePolicyRequest(core, base).status, "accepted");
  for (const bad of [
    null, "string", 7,
    { ...base, protocol: 99 },
    { ...base, instanceId: "" },
    { ...base, sessionId: undefined },
    { ...base, generation: -1 },
    { ...base, generation: 1.5 },
    { ...base, requestId: "1" },
    { ...base, kind: 5 },
  ]) {
    const reply = handlePolicyRequest(core, bad);
    assert.equal(reply.kind, POLICY_MESSAGE.refused, JSON.stringify(bad));
    assert.equal(reply.reason.code, "bad-envelope");
  }
  const unknown = handlePolicyRequest(core, { ...base, kind: "policy/render" });
  assert.equal(unknown.kind, POLICY_MESSAGE.refused);
  assert.equal(unknown.reason.code, "unknown-request");
  assert.equal(unknown.requestId, 1);
});

test("[R-CHECK-ACCEPTANCE] a fault anywhere behind the boundary becomes a rejection, never an acceptance", { skip }, async () => {
  const core = createPolicyCore({
    classes: CLASSES,
    checker: await authority(),
    candidateBuilder: () => { throw new Error("candidate builder exploded"); },
  });
  const reply = handlePolicyRequest(core, {
    protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.preprocess,
    instanceId: "i", sessionId: "s", generation: 0, requestId: 3, html: "<p>x</p>",
  });
  assert.equal(reply.kind, POLICY_MESSAGE.result);
  assert.equal(reply.status, "rejected");
  assert.equal(reply.reason.code, "checker-failed");
  assert.match(reply.reason.detail, /candidate builder exploded/);
  assert.equal(reply.tree, undefined);
  assert.equal(reply.acceptance, undefined);
});

// --- lifecycle: timeouts, termination, identity, single settlement ----------

test("[R-RT-LIMITS] a request over its budget terminates the Worker and settles once", { skip }, async () => {
  await authority();
  const { worker, client } = session({ hang: true });
  const terminations = [];
  const timed = createPolicySession({
    createWorker: () => worker,
    classes: CLASSES,
    timeouts: { startupMs: 25, requestMs: 25 },
    onTerminated: (event) => terminations.push(event),
  });
  const first = timed.preprocess(deep());
  const second = timed.preprocess("<p>queued behind it</p>");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "rejected");
  assert.equal(a.reason.code, "timeout");
  assert.equal(a.reason.limitValue, 25);
  // Everything else pending settles too - no promise is left hanging.
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.code, "session-terminated");
  assert.equal(worker.terminated, true);
  assert.equal(timed.pendingCount, 0);
  assert.equal(timed.alive, false);
  assert.equal(terminations.length, 1);
  assert.equal(terminations[0].code, "timeout");
  timed.dispose();
  client.dispose();
});

test("[R-RT-LIMITS] the next request after a termination runs on a fresh Worker with a new session id", { skip }, async () => {
  await authority();
  let created = 0;
  const workers = [];
  const client = createPolicySession({
    createWorker: () => {
      created += 1;
      const worker = fakeWorker(created === 1 ? { hang: true } : {});
      workers.push(worker);
      return worker;
    },
    classes: CLASSES,
    timeouts: { startupMs: 25, requestMs: 25 },
  });
  const dead = await client.preprocess("<p>x</p>");
  assert.equal(dead.reason.code, "timeout");
  const deadSession = workers[0];
  const revived = await client.preprocess(`<p class="muted">alive</p>`);
  assert.equal(revived.status, "accepted");
  assert.equal(created, 2);
  assert.equal(deadSession.terminated, true);
  // Identity is stable per instance and fresh per session.
  assert.equal(workers[1].posted[0].instanceId, client.instanceId);
  assert.notEqual(workers[1].posted[0].sessionId, workers[0].posted[0]?.sessionId);
  assert.equal(client.stats.timeouts, 1);
  assert.equal(client.stats.sessions, 2);
  client.dispose();
});

test("[R-FRAME-MESSAGE-SCHEMA] duplicate, stale and foreign replies are dropped; each request settles once", { skip }, async () => {
  await authority();
  let settled = 0;
  const { client } = session({ duplicate: true });
  const result = await client.preprocess("<p>x</p>");
  settled += 1;
  assert.equal(result.status, "accepted");
  // A duplicate of the same reply arrived; the pending entry was already gone.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, 1);
  assert.equal(client.pendingCount, 0);

  // A reply that claims a foreign session or an unknown request id is ignored,
  // so the request runs out its budget instead of being settled by it.
  const foreign = createPolicySession({
    createWorker: () => fakeWorker({ mangle: (reply) => ({ ...reply, sessionId: "somebody-else" }) }),
    classes: CLASSES,
    timeouts: { startupMs: 30, requestMs: 30 },
  });
  const ignored = await foreign.preprocess("<p>x</p>");
  assert.equal(ignored.status, "rejected");
  assert.equal(ignored.reason.code, "timeout");
  foreign.dispose();
  client.dispose();
});

test("[R-FRAME-MESSAGE-SCHEMA] a reply for a superseded generation never returns a tree", { skip }, async () => {
  await authority();
  const client = createPolicySession({
    createWorker: () => fakeWorker(),
    classes: CLASSES,
    timeouts: { startupMs: 60, requestMs: 60 },
  });
  const pending = client.preprocess("<p>old document</p>");
  client.nextGeneration(); // an explicit replacement arrived
  const result = await pending;
  assert.equal(result.status, "superseded");
  assert.equal(result.tree, undefined);
  assert.equal(client.generation, 1);
  client.dispose();
});

test("[R-RT-LIMITS] dispose settles pending work, terminates the Worker, and is idempotent", { skip }, async () => {
  await authority();
  const { worker, client } = session({ hang: true });
  const pending = client.preprocess("<p>x</p>");
  client.dispose();
  client.dispose();
  const result = await pending;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "session-terminated");
  assert.equal(worker.terminated, true);
  assert.throws(() => client.preprocess("<p>x</p>"), /disposed/);
});

test("[R-RT-LIMITS] a worker error settles pending work without waiting for the watchdog", { skip }, async () => {
  await authority();
  const workers = [];
  const terminations = [];
  const client = createPolicySession({
    createWorker: () => {
      const worker = fakeWorker({ hang: true });
      workers.push(worker);
      return worker;
    },
    classes: CLASSES,
    // Long budgets: the error path, not the timer, must settle this.
    timeouts: { startupMs: 60_000, requestMs: 60_000 },
    onTerminated: (event) => terminations.push(event),
  });
  const pending = client.preprocess("<p>x</p>");
  // After the channel-handshake stage: a later failure is a runtime worker
  // error, not a startup error. The pre-handshake case has its own code and
  // its own test in test/startup.test.js.
  await client.whenReady();
  workers[0].emitError("policy worker crashed");
  const result = await pending;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "session-terminated");
  assert.equal(result.reason.detail, "worker-error");
  assert.equal(workers[0].terminated, true);
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(terminations.map((event) => event.code), ["worker-error"]);
  client.dispose();
});

// --- the Worker must never be able to run generated JavaScript --------------

test("[R-RT-ISOLATION] no module reachable from the policy Worker can execute generated JavaScript", () => {
  const files = [
    "src/policy-worker.js", "src/policy-dispatcher.js", "src/policy-core.js", "src/policy-protocol.js",
    "src/policy-client.js", "src/adapters/parse5.js",
    // The Lean authority path is inside the policy Worker too, so it is held
    // to the same rule.
    "src/lean-checker.js", "src/lean-abi.js", "src/lean-module.js", "src/acceptance.js",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // Comments mention these names on purpose; code must not call them.
    const code = source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [
      /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bimportScripts\b/,
      /\bimport\s*\(/, /quickjs/i, /createCore\b/,
    ]) {
      assert.ok(!forbidden.test(code), `${file} must not contain ${forbidden}`);
    }
  }
});

test("[R-RT-ISOLATION] the Worker entry only answers the policy protocol", () => {
  const source = readFileSync(new URL("../src/policy-worker.js", import.meta.url), "utf8");
  assert.ok(source.includes("createPolicyDispatcher"));
  assert.ok(source.includes("dispatcher.receive(event.data, event.ports)"));
  // No other message handler and no capability plumbing.
  assert.equal(source.match(/addEventListener/g).length, 1);
});

test("[R-LIMIT-TREE] boundDiagnostics keeps its own contract", () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ kind: "removed-attribute", name: `a${i}` }));
  const bounded = boundDiagnostics(many);
  assert.equal(bounded.total, 1000);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.records.length <= PREPROCESS_LIMITS.maxDiagnosticRecords);
  assert.ok(bounded.bytes <= PREPROCESS_LIMITS.maxDiagnosticsUtf8Bytes);
  assert.deepEqual(boundDiagnostics([]), { records: [], total: 0, truncated: false, bytes: 0 });
  assert.deepEqual(boundDiagnostics(undefined).records, []);
});
