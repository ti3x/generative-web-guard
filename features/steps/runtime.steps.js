// Step definitions for the QuickJS runtime, the host-side controller and the
// AST gate. JavaScript-only rules: R-RT-ISOLATION, R-RT-LIMITS,
// R-RT-FROZEN-DATA, R-GATE-INTERFACE.
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { getQuickJS } from "quickjs-emscripten";
import { createCore } from "../../src/runtime/core.js";
import { createRuntimeController } from "../../src/runtime/controller.js";
import { PROTOCOL_VERSION } from "../../src/runtime/protocol.js";
import { gateProgram } from "../../src/gate.js";

// QuickJS is loaded once per process.
let quickjsPromise = null;
const quickjs = () => (quickjsPromise ??= getQuickJS());

// In-process fake worker driving a real core, as in test/runtime.test.js. It
// speaks the protocol in src/runtime/protocol.js. hangOn silences one request
// type to exercise a watchdog or disposal; mutate lets a scenario post a reply
// the controller must reject at its receive boundary.
function fakeWorker(core, { hang = false, hangOn = null, mutate = null } = {}) {
  const listeners = { message: [], messageerror: [], error: [] };
  return {
    terminated: false,
    addEventListener: (t, fn) => listeners[t].push(fn),
    terminate() { this.terminated = true; },
    postMessage(msg) {
      if (hang || msg.type === hangOn) return;
      let reply;
      try {
        let result;
        if (msg.type === "load") { core.load(msg.source, msg.data ?? null); result = { loaded: true }; }
        else if (msg.type === "init") result = core.init();
        else result = core.step(msg.state, msg.event);
        reply = { v: PROTOCOL_VERSION, id: msg.id, ok: true, result };
      } catch (err) {
        reply = { v: PROTOCOL_VERSION, id: msg.id, ok: false, error: err.message };
      }
      if (mutate) reply = mutate(reply, msg);
      setTimeout(() => listeners.message.forEach((fn) => fn({ data: reply })), 0);
    },
  };
}

// Records how long the attempt took as well as its outcome: a hostile case
// has to fail *within* its budget, not merely fail.
function tryRun(world, fn) {
  world.rtError = null;
  const started = Date.now();
  try {
    return fn();
  } catch (err) {
    world.rtError = err;
    return null;
  } finally {
    world.rtMs = Date.now() - started;
  }
}

// Reply rewrites used by the malformed-reply scenarios. Each one produces a
// packet the controller must refuse at its receive boundary.
const REPLY_DEFECTS = {
  "an extra field": (reply) => ({ ...reply, result: { ...reply.result, extra: 1 } }),
  "no result": (reply) => ({ v: reply.v, id: reply.id, ok: true }),
  "an oversized view": (reply) => ({ ...reply, result: { ...reply.result, view: "x".repeat(500001) } }),
  "a mismatched id": (reply) => ({ ...reply, id: reply.id + 100 }),
};

// --- Given ------------------------------------------------------------------

Given("the program:", function (source) {
  this.program = source;
  this.rtLimits = this.rtLimits ?? {};
});

Given("host data:", function (json) {
  this.hostData = json.trim();
});

Given("a runtime step budget of {int} ms", function (ms) {
  this.rtLimits = { ...(this.rtLimits ?? {}), stepMs: ms };
});

Given("a runtime memory limit of {int} MiB", function (mib) {
  this.rtLimits = { ...(this.rtLimits ?? {}), memoryBytes: mib * 1024 * 1024, stepMs: 2000 };
});

Given("a runtime stack limit of {int} KiB", function (kib) {
  this.rtLimits = { ...(this.rtLimits ?? {}), stackBytes: kib * 1024 };
});

Given("a view size limit of {int} characters", function (n) {
  this.rtLimits = { ...(this.rtLimits ?? {}), maxViewChars: n };
});

Given("a host data size limit of {int} characters", function (n) {
  this.rtLimits = { ...(this.rtLimits ?? {}), maxDataChars: n };
});

Given("a state size limit of {int} characters", function (n) {
  this.rtLimits = { ...(this.rtLimits ?? {}), maxStateChars: n };
});

// --- When: core -------------------------------------------------------------

When("the runtime initializes", async function () {
  const QuickJS = await quickjs();
  this.core = createCore(QuickJS, this.rtLimits ?? {});
  const init = tryRun(this, () => {
    this.core.load(this.program, this.hostData ?? null);
    return this.core.init();
  });
  if (init) { this.rtState = init.state; this.rtView = init.view; }
});

When("the runtime steps with event {string}", function (action) {
  assert.ok(this.core && this.rtState, "runtime not initialized");
  const result = tryRun(this, () => this.core.step(this.rtState, JSON.stringify({ type: "click", action })));
  if (result) { this.rtState = result.state; this.rtView = result.view; }
});

When("the runtime loads the program", async function () {
  const QuickJS = await quickjs();
  this.core = createCore(QuickJS, this.rtLimits ?? {});
  tryRun(this, () => this.core.load(this.program, this.hostData ?? null));
});

// --- When: controller -------------------------------------------------------

When("the controller loads the program", async function () {
  const QuickJS = await quickjs();
  const core = createCore(QuickJS, this.rtLimits ?? {});
  this.rc = createRuntimeController({ createWorker: () => fakeWorker(core), maxQueue: this.rcMaxQueue ?? 32 });
  const data = this.hostData === undefined ? undefined : JSON.parse(this.hostData);
  const init = await this.rc.load(this.program, data);
  this.rtView = init.view;
});

When("the controller receives {int} increment events at once", async function (n) {
  const results = await Promise.allSettled(Array.from({ length: n }, () => this.rc.step({ type: "click", action: "increment" })));
  this.rcResults = results;
  const last = results.filter((r) => r.status === "fulfilled").at(-1);
  if (last) this.rtView = last.value.view;
});

When("the controller loads the program on a hung worker with a {int} ms watchdog", async function (ms) {
  const QuickJS = await quickjs();
  const core = createCore(QuickJS);
  this.worker = fakeWorker(core, { hang: true });
  this.deadReason = null;
  this.rc = createRuntimeController({ createWorker: () => this.worker, watchdogMs: ms, loadWatchdogMs: ms, onDead: (r) => (this.deadReason = r) });
  this.rtError = null;
  try { await this.rc.load(this.program); } catch (err) { this.rtError = err; }
});

Given("the controller queue holds at most {int} events", function (n) {
  this.rcMaxQueue = n;
});

When("the controller loads the program on a worker whose init reply has {string}", async function (defect) {
  const QuickJS = await quickjs();
  const core = createCore(QuickJS, this.rtLimits ?? {});
  const rewrite = REPLY_DEFECTS[defect];
  assert.ok(rewrite, `unknown reply defect: ${defect}`);
  this.worker = fakeWorker(core, { mutate: (reply, request) => (request.type === "init" ? rewrite(reply) : reply) });
  this.deadReason = null;
  this.rc = createRuntimeController({ createWorker: () => this.worker, onDead: (r) => (this.deadReason = r) });
  this.rtError = null;
  try { await this.rc.load(this.program); } catch (err) { this.rtError = err; }
});

When("the controller steps before loading the program", async function () {
  const QuickJS = await quickjs();
  const core = createCore(QuickJS, this.rtLimits ?? {});
  this.rc = createRuntimeController({ createWorker: () => fakeWorker(core) });
  this.rtError = null;
  try { await this.rc.step({ type: "click", action: "increment" }); } catch (err) { this.rtError = err; }
});

When("the controller is disposed with {int} events outstanding on a worker that never answers steps", async function (n) {
  const QuickJS = await quickjs();
  const core = createCore(QuickJS, this.rtLimits ?? {});
  this.worker = fakeWorker(core, { hangOn: "step" });
  this.rc = createRuntimeController({ createWorker: () => this.worker, watchdogMs: 5000 });
  await this.rc.load(this.program);
  const pending = Array.from({ length: n }, () => this.rc.step({ type: "click", action: "increment" }));
  this.rc.dispose();
  this.rcResults = await Promise.allSettled(pending);
});

// --- When: gate -------------------------------------------------------------

When("the gate checks the program", function () {
  this.gate = gateProgram(this.program);
});

// --- Then -------------------------------------------------------------------

Then("the view is {string}", function (expected) {
  assert.ok(!this.rtError, `runtime error: ${this.rtError?.message}`);
  assert.equal(this.rtView, expected);
});

Then("the view contains {string}", function (s) {
  assert.ok(!this.rtError, `runtime error: ${this.rtError?.message}`);
  assert.ok(this.rtView.includes(s), `view ${JSON.stringify(this.rtView)} does not contain ${JSON.stringify(s)}`);
});

Then("the step fails with {string}", function (pattern) {
  assert.ok(this.rtError, "expected the step to fail");
  assert.match(this.rtError.message, new RegExp(pattern, "i"));
});

Then("the step fails", function () {
  assert.ok(this.rtError, "expected the step to fail");
});

Then("loading fails with {string}", function (pattern) {
  assert.ok(this.rtError, "expected loading to fail");
  assert.match(this.rtError.message, new RegExp(pattern, "i"));
});

Then("the runtime is dead with reason matching {string}", function (pattern) {
  assert.equal(this.rc.dead, true);
  assert.match(String(this.deadReason ?? this.rtError?.message), new RegExp(pattern, "i"));
});

Then("the worker was terminated", function () {
  assert.equal(this.worker.terminated, true);
});

Then("at least {int} events were rejected as queue full", function (n) {
  const rejected = this.rcResults.filter((r) => r.status === "rejected");
  assert.ok(rejected.length >= n, `only ${rejected.length} rejected`);
  assert.ok(rejected.every((r) => /queue full/.test(r.reason.message)));
  assert.equal(this.rc.droppedEvents, rejected.length);
});

Then("the step failed within {int} ms", function (ms) {
  assert.ok(this.rtError, "expected the step to fail");
  assert.ok(this.rtMs <= ms, `the failure took ${this.rtMs}ms, above the ${ms}ms bound`);
});

Then("stepping fails with {string}", function (pattern) {
  assert.ok(this.rtError, "expected the step to fail");
  assert.match(this.rtError.message, new RegExp(pattern, "i"));
});

Then("the runtime is not dead", function () {
  assert.equal(this.rc.dead, false);
});

Then("all {int} outstanding events were rejected with {string}", function (n, pattern) {
  assert.equal(this.rcResults.length, n);
  const expected = new RegExp(pattern, "i");
  for (const result of this.rcResults) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, expected);
  }
});

Then("the gate accepts it", function () {
  assert.equal(this.gate.status, "eligible-for-restricted-execution", JSON.stringify(this.gate.reasons));
});

Then("the gate rejects it with {string}", function (code) {
  assert.equal(this.gate.status, "rejected", "gate accepted the program");
  assert.ok(this.gate.reasons.some((r) => r.code === code), `codes: ${this.gate.reasons.map((r) => r.code).join(", ")}`);
});

Then("every gate rejection except syntax carries a location", function () {
  assert.ok(this.gate.reasons.every((r) => r.code === "module-syntax" || r.code === "syntax" || r.code === "missing" || typeof r.line === "number"));
});
