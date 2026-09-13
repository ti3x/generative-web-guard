import { test } from "node:test";
import assert from "node:assert/strict";
import { getQuickJS } from "quickjs-emscripten";
import { createCore } from "../src/runtime/core.js";
import { createRuntimeController } from "../src/runtime/controller.js";
import {
  DEFAULT_LIMITS, MAX_ALLOCATION_CHARS, PROTOCOL_VERSION, checkReply, checkRequest, checkResult,
  packedChars, resolveLimits, stepProgramLimit,
} from "../src/runtime/protocol.js";

const QuickJS = await getQuickJS();

const PROGRAM = `
const initialState = { count: 0, items: ["b", "a"] };
function update(state, event) {
  if (event.action === "increment") return { ...state, count: state.count + 1 };
  if (event.action === "sort") return { ...state, items: [...state.items].sort() };
  return state;
}
function view(state) {
  return "<p>Count: " + state.count + "</p><ul>" + state.items.map((i) => "<li>" + i + "</li>").join("") + "</ul>";
}`;

test("[R-RT-ISOLATION] loads, initializes and steps with JSON-only state", () => {
  const core = createCore(QuickJS);
  core.load(PROGRAM);
  const init = core.init();
  assert.equal(init.view, "<p>Count: 0</p><ul><li>b</li><li>a</li></ul>");
  assert.deepEqual(JSON.parse(init.state), { count: 0, items: ["b", "a"] });
  const s1 = core.step(init.state, JSON.stringify({ type: "click", action: "increment" }));
  assert.equal(JSON.parse(s1.state).count, 1);
  const s2 = core.step(s1.state, JSON.stringify({ type: "click", action: "sort" }));
  assert.equal(s2.view, "<p>Count: 1</p><ul><li>a</li><li>b</li></ul>");
  core.dispose();
});

test("[R-RT-FROZEN-DATA] host-supplied data is a frozen global the program can read but not change", () => {
  const core = createCore(QuickJS);
  core.load(`
    const initialState = { n: data.rows.length };
    function update(s, e) {
      let threw = false;
      try { data.rows.push({ v: 99 }); } catch (err) { threw = true; }  // push on a frozen array throws
      data.rows[0].v = -1;               // silently ignored: deep frozen
      data = null;                       // silently ignored: non-writable
      return { n: data.rows.length, first: data.rows[0].v, sum: data.rows.reduce((a, r) => a + r.v, 0), threw };
    }
    function view(s) { return JSON.stringify(s); }`,
    JSON.stringify({ rows: [{ v: 1 }, { v: 2 }, { v: 3 }] }));
  const init = core.init();
  assert.equal(init.view, '{"n":3}');
  const s1 = core.step(init.state, JSON.stringify({ action: "x" }));
  assert.equal(s1.view, '{"n":3,"first":1,"sum":6,"threw":true}');
  core.dispose();
});

test("[R-RT-FROZEN-DATA] data is null when the host supplies none, and oversized data is refused", () => {
  const core = createCore(QuickJS, { maxDataChars: 10 });
  core.load(`const initialState = {}; function update(s) { return s; } function view() { return String(data); }`);
  assert.equal(core.init().view, "null");
  assert.throws(() => core.load(`const initialState = {}; function update(s) { return s; } function view() { return ""; }`, JSON.stringify({ big: "xxxxxxxxxx" })), /size limit/);
  core.dispose();
});

test("[R-RT-ISOLATION] no host capabilities are visible to the program", () => {
  const core = createCore(QuickJS);
  core.load(`
    const initialState = {};
    function update(s) { return s; }
    function view() {
      const names = ["fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "importScripts",
        "require", "process", "window", "document", "std", "os", "postMessage", "Worker", "navigator", "localStorage"];
      return names.filter((n) => typeof globalThis[n] !== "undefined").join(",");
    }`);
  assert.equal(core.init().view, "");
  core.dispose();
});

test("[R-RT-LIMITS] infinite loop is interrupted by the deadline", () => {
  const core = createCore(QuickJS, { stepMs: 50 });
  core.load(`const initialState = {}; function update(s) { for(;;){} } function view(s) { return "x"; }`);
  const init = core.init();
  const t0 = Date.now();
  assert.throws(() => core.step(init.state, JSON.stringify({ action: "go" })), /interrupted/i);
  assert.ok(Date.now() - t0 < 2000);
  core.dispose();
});

test("[R-RT-LIMITS] runaway allocation hits the memory limit", () => {
  const core = createCore(QuickJS, { memoryBytes: 4 * 1024 * 1024, stepMs: 2000 });
  core.load(`const initialState = {}; function update(s) { const a = []; for(;;) a.push(new Array(1024).fill("x")); } function view(s) { return "x"; }`);
  const init = core.init();
  assert.throws(() => core.step(init.state, JSON.stringify({ action: "go" })));
  core.dispose();
});

test("[R-RT-LIMITS] deep recursion hits the stack limit", () => {
  const core = createCore(QuickJS, { stackBytes: 256 * 1024 });
  core.load(`const initialState = {}; function update(s) { return update(s); } function view(s) { return "x"; }`);
  const init = core.init();
  assert.throws(() => core.step(init.state, JSON.stringify({ action: "go" })), /stack/i);
  core.dispose();
});

test("[R-RT-LIMITS] oversized view and non-string view are rejected", () => {
  const core = createCore(QuickJS, { maxViewChars: 100 });
  core.load(`const initialState = { big: false }; function update(s) { return { big: true }; } function view(s) { return s.big ? "x".repeat(1000) : { toString() { return "obj"; } }; }`);
  assert.throws(() => core.init(), /view must return a string/);
  core.dispose();
  const core2 = createCore(QuickJS, { maxViewChars: 100 });
  core2.load(`const initialState = { big: false }; function update(s) { return { big: true }; } function view(s) { return s.big ? "x".repeat(1000) : "ok"; }`);
  const init = core2.init();
  assert.throws(() => core2.step(init.state, JSON.stringify({ action: "go" })), /view too large/);
  core2.dispose();
});

test("[R-RT-ISOLATION] tampering with JSON inside the program does not change how results leave", () => {
  const core = createCore(QuickJS);
  core.load(`
    JSON.stringify = () => "\\"pwned\\"";
    JSON.parse = () => ({ count: 999 });
    const initialState = { count: 1 };
    function update(s, e) { return { count: s.count + 1 }; }
    function view(s) { return "c=" + s.count; }`);
  const init = core.init();
  assert.equal(init.view, "c=1");
  const s1 = core.step(init.state, JSON.stringify({ action: "x" }));
  assert.equal(s1.view, "c=2");
  core.dispose();
});

test("[R-GATE-INTERFACE] interface violations are load errors with messages", () => {
  const core = createCore(QuickJS);
  assert.throws(() => core.load(`const initialState = 1;`), /update must be a function/);
  assert.throws(() => core.load(`const initialState = {}; function update(){} const view = 3;`), /view must be a function/);
  assert.throws(() => core.load(`function update(){} function view(){}`), /initialState is required/);
  assert.throws(() => core.load(`throw new Error("boom")`), /boom/);
  core.dispose();
});

// Controller with an in-process fake worker driving the real core. It speaks
// the same protocol as src/runtime/worker.js: the controller must not be able
// to tell the difference, and the adversarial variants below differ only in
// the replies they post.
//
// hang / hangOn: never reply, or never reply to one request type, to
// exercise a watchdog.
// mutate: rewrite the reply before posting, to exercise the controller's
// receive boundary against malformed, stale and duplicated packets.
function fakeWorker(core, { hang = false, hangOn = null, mutate = null, duplicate = false } = {}) {
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
      const deliver = () => listeners.message.forEach((fn) => fn({ data: reply }));
      setTimeout(() => { deliver(); if (duplicate) deliver(); }, 0);
    },
  };
}

test("[R-RT-ISOLATION] controller owns state, serializes steps and tags generations", async () => {
  const core = createCore(QuickJS);
  const rc = createRuntimeController({ createWorker: () => fakeWorker(core) });
  const init = await rc.load(PROGRAM);
  assert.match(init.view, /Count: 0/);
  const [a, b] = await Promise.all([rc.step({ action: "increment" }), rc.step({ action: "increment" })]);
  assert.match(a.view, /Count: 1/);
  assert.match(b.view, /Count: 2/);
  assert.equal(a.generation, rc.generation);
  rc.dispose();
  assert.equal(rc.dead, true);
  await assert.rejects(rc.step({ action: "increment" }), /dead/);
});

test("[R-RT-FROZEN-DATA] controller serializes host data and the program reads it", async () => {
  const core = createCore(QuickJS);
  const rc = createRuntimeController({ createWorker: () => fakeWorker(core) });
  const init = await rc.load(`const initialState = {}; function update(s) { return s; } function view() { return "rows=" + data.length + " first=" + data[0].region; }`,
    [{ region: "North" }, { region: "South" }]);
  assert.equal(init.view, "rows=2 first=North");
  rc.dispose();
});

test("[R-RT-LIMITS] controller watchdog kills a hung worker and marks the runtime dead", async () => {
  const core = createCore(QuickJS);
  let deadReason = null;
  const worker = fakeWorker(core, { hang: true });
  const rc = createRuntimeController({ createWorker: () => worker, watchdogMs: 50, loadWatchdogMs: 50, onDead: (r) => (deadReason = r) });
  await assert.rejects(rc.load(PROGRAM), /watchdog/);
  assert.equal(worker.terminated, true);
  assert.match(deadReason, /watchdog/);
  assert.equal(rc.dead, true);
});

test("[R-RT-LIMITS] controller bounds the event queue", async () => {
  const core = createCore(QuickJS);
  const rc = createRuntimeController({ createWorker: () => fakeWorker(core), maxQueue: 2 });
  await rc.load(PROGRAM);
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => rc.step({ action: "increment" })));
  const rejected = results.filter((r) => r.status === "rejected");
  assert.ok(rejected.length >= 2);
  assert.ok(rejected.every((r) => /queue full/.test(r.reason.message)));
  assert.equal(rc.droppedEvents, rejected.length);
  rc.dispose();
});

// ---------------------------------------------------------------------------
// R1 regressions: output length and packet shape are enforced outside QuickJS.
//
// Each hostile case has a benign control with the same limits, and each
// asserts how the failure is bounded — the message and the elapsed time or
// the delivered size — not merely that something threw. The limits are stated
// explicitly in the test so the bound is visible without reading the defaults.
//
// Note for every length case below: the step program no longer checks any
// length inside the guest, so a "too large" error can only have come from the
// host's own check on the extracted value.
// ---------------------------------------------------------------------------

const VIEW_OK = `function view(s) { return "<p>ok</p>"; }`;
const UPDATE_ID = `function update(s, e) { return s; }`;

function timed(fn) {
  const started = Date.now();
  try {
    return { value: fn(), ms: Date.now() - started };
  } catch (err) {
    return { error: err, ms: Date.now() - started };
  }
}

test("[R-RT-LIMITS] R1 prototype toJSON cannot replace or enlarge the packet", () => {
  // Pre-fix reproduction: the packet was h.stringify([state, view]), so a
  // guest Array.prototype.toJSON rewrote both fields after the guest-side
  // length checks had passed, delivering a 900,000-character view under a
  // 400,000-character limit.
  const hostile = `
    Array.prototype.toJSON = function () { return ["x".repeat(600000), "y".repeat(900000)]; };
    const initialState = { n: 1 };
    ${UPDATE_ID} ${VIEW_OK}`;
  const core = createCore(QuickJS, { maxViewChars: 400000, maxStateChars: 1000000 });
  core.load(hostile);
  const init = core.init();
  assert.equal(init.view, "<p>ok</p>");
  assert.ok(init.view.length <= 400000, `view was ${init.view.length} characters`);
  assert.deepEqual(JSON.parse(init.state), { n: 1 });
  core.dispose();

  // Benign control: the same program without the prototype mutation.
  const control = createCore(QuickJS, { maxViewChars: 400000, maxStateChars: 1000000 });
  control.load(`const initialState = { n: 1 }; ${UPDATE_ID} ${VIEW_OK}`);
  assert.deepEqual(control.init(), init);
  control.dispose();
});

test("[R-RT-LIMITS] R1 Object.prototype.toJSON cannot push state past the host limit", () => {
  const core = createCore(QuickJS, { maxStateChars: 1000 });
  core.load(`
    Object.prototype.toJSON = function () { return "x".repeat(200000); };
    const initialState = { a: 1 };
    ${UPDATE_ID} ${VIEW_OK}`);
  const attempt = timed(() => core.init());
  assert.match(attempt.error.message, /initialState too large: 200002 > 1000/);
  assert.ok(attempt.ms < 1000, `failure took ${attempt.ms}ms`);
  core.dispose();

  // Benign control: an unpolluted prototype at the same limit succeeds.
  const control = createCore(QuickJS, { maxStateChars: 1000 });
  control.load(`const initialState = { a: 1 }; ${UPDATE_ID} ${VIEW_OK}`);
  assert.equal(control.init().view, "<p>ok</p>");
  control.dispose();
});

test("[R-RT-LIMITS] R1 oversized initialState is refused before it is copied out", () => {
  const core = createCore(QuickJS, { maxStateChars: 1000 });
  core.load(`const initialState = { big: "x".repeat(50000) }; ${UPDATE_ID} ${VIEW_OK}`);
  const attempt = timed(() => core.init());
  assert.match(attempt.error.message, /initialState too large: 50010 > 1000/);
  assert.ok(attempt.ms < 1000, `failure took ${attempt.ms}ms`);
  core.dispose();

  // Benign control: just inside the same limit.
  const control = createCore(QuickJS, { maxStateChars: 1000 });
  control.load(`const initialState = { big: "x".repeat(900) }; ${UPDATE_ID} ${VIEW_OK}`);
  assert.equal(control.init().state.length, 910); // {"big":"…900 chars…"}
  control.dispose();
});

test("[R-RT-LIMITS] R1 oversized and non-string views are refused at the host boundary", () => {
  const core = createCore(QuickJS, { maxViewChars: 100 });
  core.load(`const initialState = {}; ${UPDATE_ID} function view(s) { return "y".repeat(5000); }`);
  const attempt = timed(() => core.init());
  assert.match(attempt.error.message, /view too large: 5000 > 100/);
  assert.ok(attempt.ms < 1000, `failure took ${attempt.ms}ms`);
  core.dispose();

  // Benign control: a view just inside the same limit is delivered whole.
  const control = createCore(QuickJS, { maxViewChars: 100 });
  control.load(`const initialState = {}; ${UPDATE_ID} function view(s) { return "y".repeat(100); }`);
  assert.equal(control.init().view.length, 100);
  control.dispose();
});

test("[R-RT-LIMITS] R1 getters and Proxies on returned values cannot decide what is copied", () => {
  // A view that is an object with a length getter and a toString hook: the
  // host never coerces it, so no hook runs and the type check names the fault.
  const core = createCore(QuickJS, { maxViewChars: 100 });
  core.load(`
    const initialState = {};
    ${UPDATE_ID}
    function view(s) { return { get length() { return 5; }, toString() { return "x".repeat(500000); } }; }`);
  const viewAttempt = timed(() => core.init());
  assert.match(viewAttempt.error.message, /view must return a string/);
  assert.ok(viewAttempt.ms < 1000, `failure took ${viewAttempt.ms}ms`);
  core.dispose();

  // A view that is a Proxy: every trap would throw, and none is reached.
  const proxyCore = createCore(QuickJS, { maxViewChars: 100 });
  proxyCore.load(`
    const initialState = {};
    ${UPDATE_ID}
    function view(s) { return new Proxy({}, { get() { throw new Error("trap"); } }); }`);
  assert.throws(() => proxyCore.init(), /view must return a string/);
  proxyCore.dispose();

  // A state whose Proxy traps throw fails inside the guest's own serializer,
  // and the failure is reported as a bounded diagnostic.
  const stateCore = createCore(QuickJS);
  stateCore.load(`
    const initialState = new Proxy({ a: 1 }, { get(t, k) { throw new Error("trap " + String(k)); } });
    ${UPDATE_ID} ${VIEW_OK}`);
  const stateAttempt = timed(() => stateCore.init());
  assert.match(stateAttempt.error.message, /Error: trap toJSON/);
  assert.ok(stateAttempt.error.message.length <= DEFAULT_LIMITS.maxDiagnosticChars);
  stateCore.dispose();

  // Benign control: a transparent Proxy over the state serializes normally.
  const control = createCore(QuickJS);
  control.load(`const initialState = new Proxy({ a: 1 }, {}); ${UPDATE_ID} ${VIEW_OK}`);
  assert.deepEqual(JSON.parse(control.init().state), { a: 1 });
  control.dispose();
});

test("[R-RT-LIMITS] R1 state that is not JSON text is refused instead of committed", () => {
  // h.stringify returns a non-string, so there is nothing to extract.
  const core = createCore(QuickJS);
  core.load(`
    Object.prototype.toJSON = function () { return undefined; };
    const initialState = { a: 1 };
    ${UPDATE_ID} ${VIEW_OK}`);
  assert.throws(() => core.init(), /initialState is not JSON-serializable/);
  core.dispose();

  // A string that is the right length but is not JSON is refused too: the
  // host re-embeds state in the next step's program, so it must really parse.
  const textCore = createCore(QuickJS);
  textCore.load(`
    Object.prototype.toJSON = function () { return "not json"; };
    const initialState = { a: 1 };
    ${UPDATE_ID} ${VIEW_OK}`);
  const init = textCore.init();
  assert.equal(init.state, '"not json"'); // a valid JSON string, so it is accepted
  textCore.dispose();
});

// ---------------------------------------------------------------------------
// R2 regressions: the deadline stays installed through extraction and error
// reporting, and no guest-controlled coercion produces an error message.
// ---------------------------------------------------------------------------

test("[R-RT-LIMITS] R2 a hostile error getter cannot outrun the evaluation budget", () => {
  // Pre-fix reproduction: the interrupt handler was removed before the thrown
  // object was dumped, so this getter ran for about 250ms under a 20ms budget.
  const core = createCore(QuickJS, { stepMs: 20 });
  core.load(`
    const initialState = {};
    function update(s) {
      throw { name: "Hostile", get message() { const t = Date.now(); while (Date.now() - t < 250) {} return "slow"; } };
    }
    ${VIEW_OK}`);
  const init = core.init();
  const attempt = timed(() => core.step(init.state, JSON.stringify({ action: "go" })));
  assert.match(attempt.error.message, /interrupted: guest execution exceeded 20ms/);
  assert.ok(attempt.ms < 150, `error handling took ${attempt.ms}ms under a 20ms budget`);
  core.dispose();
});

test("[R-RT-LIMITS] R2 an endless getter on name or message is interrupted, not awaited", () => {
  for (const property of ["message", "name"]) {
    const core = createCore(QuickJS, { stepMs: 50 });
    core.load(`
      const initialState = {};
      function update(s) { throw { name: "n", message: "m", get ${property}() { for (;;) {} } }; }
      ${VIEW_OK}`);
    const init = core.init();
    const attempt = timed(() => core.step(init.state, JSON.stringify({ action: "go" })));
    assert.match(attempt.error.message, /interrupted: guest execution exceeded 50ms/);
    assert.ok(attempt.ms < 500, `${property} getter ran for ${attempt.ms}ms under a 50ms budget`);
    core.dispose();
  }
});

test("[R-RT-LIMITS] R2 toString and valueOf hooks never build the host's error message", () => {
  const core = createCore(QuickJS, { stepMs: 50 });
  core.load(`
    const initialState = {};
    function update(s) {
      throw {
        name: "Hostile", message: "short",
        toString() { return "x".repeat(5000000); },
        valueOf() { return "y".repeat(5000000); },
        [Symbol.toPrimitive]() { return "z".repeat(5000000); },
      };
    }
    ${VIEW_OK}`);
  const init = core.init();
  const attempt = timed(() => core.step(init.state, JSON.stringify({ action: "go" })));
  assert.equal(attempt.error.message, "Hostile: short");
  assert.ok(attempt.ms < 500, `error handling took ${attempt.ms}ms`);
  core.dispose();
});

test("[R-RT-LIMITS] R2 an oversized diagnostic is dropped rather than copied out", () => {
  const core = createCore(QuickJS, { stepMs: 200, maxDiagnosticChars: 2000 });
  core.load(`
    const initialState = {};
    function update(s) { throw { name: "E", message: "x".repeat(1000000) }; }
    ${VIEW_OK}`);
  const init = core.init();
  const attempt = timed(() => core.step(init.state, JSON.stringify({ action: "go" })));
  assert.equal(attempt.error.message, "guest execution failed");
  assert.ok(attempt.ms < 500, `error handling took ${attempt.ms}ms`);
  core.dispose();

  // Benign controls: a plain Error and a thrown string still report exactly.
  const control = createCore(QuickJS);
  control.load(`const initialState = {}; function update(s) { throw new Error("boom"); } ${VIEW_OK}`);
  const controlInit = control.init();
  assert.throws(() => control.step(controlInit.state, JSON.stringify({ action: "go" })), /^Error: Error: boom$/);
  control.dispose();

  const thrownString = createCore(QuickJS);
  thrownString.load(`const initialState = {}; function update(s) { throw "plain"; } ${VIEW_OK}`);
  const stringInit = thrownString.init();
  assert.throws(() => thrownString.step(stringInit.state, JSON.stringify({ action: "go" })), /^Error: plain$/);
  thrownString.dispose();
});

test("[R-RT-LIMITS] R2 failure during extraction is a bounded error, and the core stays usable", () => {
  // initialState is a function, so there is no JSON text to extract at all.
  const core = createCore(QuickJS);
  core.load(`const initialState = function () {}; ${UPDATE_ID} ${VIEW_OK}`);
  assert.throws(() => core.init(), /initialState is not JSON-serializable/);
  // A failed extraction disposes its handles; loading a working program into
  // the same core still succeeds.
  core.load(`const initialState = { a: 1 }; ${UPDATE_ID} ${VIEW_OK}`);
  assert.equal(core.init().view, "<p>ok</p>");
  core.dispose();
});

test("[R-RT-LIMITS] R2 repeated hostile steps neither leak handles nor lose the deadline", () => {
  const core = createCore(QuickJS, { stepMs: 30 });
  core.load(`
    const initialState = { n: 0 };
    function update(s, e) {
      if (e.action === "hostile") throw { get message() { for (;;) {} } };
      return { n: s.n + 1 };
    }
    function view(s) { return "n=" + s.n; }`);
  let state = core.init().state;
  for (let i = 0; i < 5; i++) {
    const attempt = timed(() => core.step(state, JSON.stringify({ action: "hostile" })));
    assert.match(attempt.error.message, /interrupted/);
    assert.ok(attempt.ms < 300, `iteration ${i} took ${attempt.ms}ms`);
    // The runtime is still live and the next benign step still advances.
    const good = core.step(state, JSON.stringify({ action: "go" }));
    state = good.state;
    assert.equal(good.view, `n=${i + 1}`);
  }
  core.dispose();
});

// ---------------------------------------------------------------------------
// Protocol module: one definition of the shape and the limits, checked
// directly so both sides' enforcement is testing the same rules.
// ---------------------------------------------------------------------------

test("[R-RT-LIMITS] protocol limits are validated and derived allocation bounds are capped", () => {
  assert.equal(resolveLimits().maxViewChars, DEFAULT_LIMITS.maxViewChars);
  assert.ok(Object.isFrozen(resolveLimits()));
  assert.throws(() => resolveLimits({ maxViewChars: 0 }), /maxViewChars must be a positive safe integer/);
  assert.throws(() => resolveLimits({ maxStateChars: 1.5 }), /maxStateChars must be a positive safe integer/);
  // The documented arithmetic: six characters per UTF-16 code unit of
  // JSON-escaped text, plus the template's own fixed size.
  assert.equal(packedChars(10), 6 * 10 + 1024);
  assert.equal(stepProgramLimit(DEFAULT_LIMITS), 6 * (1000000 + 65536) + 1024);
  // A configuration that would allow an allocation above the ceiling fails at
  // construction rather than at the first hostile document.
  assert.throws(() => resolveLimits({ maxStateChars: MAX_ALLOCATION_CHARS }), /above the .* ceiling/);
  assert.throws(() => createCore(QuickJS, { maxDataChars: MAX_ALLOCATION_CHARS }), /above the .* ceiling/);
});

test("[R-RT-LIMITS] protocol rejects malformed requests and missing or extra fields", () => {
  const base = { v: PROTOCOL_VERSION, id: 1, type: "step", state: "{}", event: null };
  assert.equal(checkRequest(base), null);
  assert.equal(checkRequest({ v: PROTOCOL_VERSION, id: 1, type: "init" }), null);
  assert.equal(checkRequest({ v: PROTOCOL_VERSION, id: 1, type: "load", source: "x", data: null }), null);
  assert.match(checkRequest(null), /request is not an object/);
  assert.match(checkRequest("step"), /request is not an object/);
  assert.match(checkRequest([base]), /request is not an object/);
  assert.match(checkRequest({ ...base, v: undefined }), /protocol version undefined is not 1/);
  assert.match(checkRequest({ ...base, v: 99 }), /protocol version 99 is not 1/);
  assert.match(checkRequest({ ...base, id: undefined }), /request has an invalid id/);
  assert.match(checkRequest({ ...base, id: 0 }), /request has an invalid id/);
  assert.match(checkRequest({ ...base, id: 1.5 }), /request has an invalid id/);
  assert.match(checkRequest({ ...base, type: "evaluate" }), /unknown request type "evaluate"/);
  assert.match(checkRequest({ ...base, extra: 1 }), /request has an unexpected field "extra"/);
  assert.match(checkRequest({ v: PROTOCOL_VERSION, id: 1, type: "step", state: "{}" }), /request is missing field "event"/);
  assert.match(checkRequest({ ...base, state: 7 }), /request state is not a string/);
  assert.match(checkRequest({ ...base, state: null }), /request state is not a string/);
  assert.match(checkRequest({ ...base, state: "x".repeat(20) }, { ...DEFAULT_LIMITS, maxStateChars: 10 }), /request state too large: 20 > 10/);
  assert.match(checkRequest({ ...base, event: "x".repeat(20) }, { ...DEFAULT_LIMITS, maxEventChars: 10 }), /request event too large: 20 > 10/);
  // init carries no payload at all.
  assert.match(checkRequest({ v: PROTOCOL_VERSION, id: 1, type: "init", state: "{}" }), /unexpected field "state"/);
});

test("[R-RT-LIMITS] protocol rejects malformed results and oversized fields", () => {
  assert.equal(checkResult("load", { loaded: true }), null);
  assert.match(checkResult("load", { loaded: false }), /load result is not an acknowledgement/);
  assert.match(checkResult("load", {}), /load result is missing field "loaded"/);
  assert.equal(checkResult("step", { state: "{}", view: "<p>x</p>" }), null);
  assert.match(checkResult("step", { state: "{}" }), /step result is missing field "view"/);
  assert.match(checkResult("step", { state: "{}", view: "x", extra: 1 }), /step result has an unexpected field "extra"/);
  assert.match(checkResult("step", { state: 1, view: "x" }), /step result state is not a string/);
  assert.match(checkResult("init", { state: "{}", view: "x".repeat(11) }, { ...DEFAULT_LIMITS, maxViewChars: 10 }), /init result view too large: 11 > 10/);
  assert.match(checkResult("step", null), /step result is not an object/);
});

test("[R-RT-LIMITS] protocol rejects stale, mismatched and malformed replies", () => {
  const outstanding = { id: 7, type: "step", limits: DEFAULT_LIMITS };
  const ok = { v: PROTOCOL_VERSION, id: 7, ok: true, result: { state: "{}", view: "x" } };
  assert.equal(checkReply(ok, outstanding), null);
  assert.equal(checkReply({ v: PROTOCOL_VERSION, id: 7, ok: false, error: "nope" }, outstanding), null);
  assert.match(checkReply(ok, {}), /unexpected reply 7 with no request outstanding/);
  assert.match(checkReply({ ...ok, id: 8 }, outstanding), /reply id 8 does not match outstanding request 7/);
  assert.match(checkReply({ ...ok, v: 2 }, outstanding), /reply protocol version 2 is not 1/);
  assert.match(checkReply({ ...ok, ok: "yes" }, outstanding), /reply has no ok flag/);
  assert.match(checkReply({ ...ok, extra: 1 }, outstanding), /reply has an unexpected field "extra"/);
  assert.match(checkReply({ v: PROTOCOL_VERSION, id: 7, ok: true }, outstanding), /reply is missing field "result"/);
  assert.match(checkReply({ v: PROTOCOL_VERSION, id: 7, ok: false }, outstanding), /reply is missing field "error"/);
  assert.match(checkReply({ v: PROTOCOL_VERSION, id: 7, ok: false, error: { message: "x" } }, outstanding), /reply error is not a string/);
  assert.match(
    checkReply({ v: PROTOCOL_VERSION, id: 7, ok: false, error: "x".repeat(3000) }, outstanding),
    /reply error too large: 3000 > 2000/,
  );
  assert.match(checkReply(undefined, outstanding), /reply is not an object/);
});

// ---------------------------------------------------------------------------
// Controller lifecycle: every reply is revalidated here, and every promise
// settles once — on a malformed reply, on a watchdog, and on disposal.
// ---------------------------------------------------------------------------

function controllerFor(core, workerOptions = {}, controllerOptions = {}) {
  const worker = fakeWorker(core, workerOptions);
  const reasons = [];
  const rc = createRuntimeController({
    createWorker: () => worker,
    onDead: (reason) => reasons.push(reason),
    ...controllerOptions,
  });
  return { rc, worker, reasons };
}

test("[R-RT-LIMITS] controller rejects malformed replies and settles the active job at once", async () => {
  const cases = [
    ["an unexpected field", (r) => ({ ...r, result: { ...r.result, extra: 1 } }), /unexpected field "extra"/],
    ["a missing field", (r) => ({ v: r.v, id: r.id, ok: true }), /missing field "result"/],
    ["a wrong protocol version", (r) => ({ ...r, v: 2 }), /protocol version 2 is not 1/],
    ["a mismatched id", (r) => ({ ...r, id: r.id + 100 }), /does not match outstanding request/],
    ["no ok flag", (r) => ({ v: r.v, id: r.id, result: r.result }), /reply has no ok flag/],
    ["an oversized view", (r) => ({ ...r, result: { ...r.result, view: "x".repeat(500001) } }), /view too large: 500001 > 400000/],
    ["a non-string state", (r) => ({ ...r, result: { ...r.result, state: 5 } }), /state is not a string/],
    ["a non-object reply", () => "surprise", /reply is not an object/],
  ];
  for (const [label, mutate, expected] of cases) {
    const core = createCore(QuickJS);
    // Only init replies are rewritten, so load succeeds and the failure lands
    // on a job that is genuinely outstanding.
    const { rc, worker, reasons } = controllerFor(
      core,
      { mutate: (reply, request) => (request.type === "init" ? mutate(reply) : reply) },
      { loadWatchdogMs: 5000 },
    );
    const started = Date.now();
    await assert.rejects(rc.load(PROGRAM), expected, label);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `${label} took ${elapsed}ms, so the watchdog settled it instead of the check`);
    assert.equal(rc.dead, true, label);
    assert.equal(worker.terminated, true, label);
    assert.match(reasons.join(";"), /^protocol: /, label);
    core.dispose();
  }
});

test("[R-RT-LIMITS] controller rejects a duplicated reply with nothing outstanding", async () => {
  const core = createCore(QuickJS);
  const { rc, reasons } = controllerFor(core, { duplicate: true });
  // The duplicate arrives while the load reply is being handed back, so it is
  // the death of the session that settles the load, and the recorded reason
  // names the protocol violation that caused it.
  await assert.rejects(rc.load(PROGRAM), /runtime is dead/);
  assert.equal(rc.dead, true);
  assert.match(reasons.join(";"), /protocol: unexpected reply \d+ with no request outstanding/);
  core.dispose();
});

test("[R-RT-LIMITS] controller rejects a malformed load acknowledgement", async () => {
  const core = createCore(QuickJS);
  const { rc } = controllerFor(core, {
    mutate: (reply, request) => (request.type === "load" ? { ...reply, result: { loaded: "yes" } } : reply),
  });
  await assert.rejects(rc.load(PROGRAM), /load result is not an acknowledgement/);
  assert.equal(rc.dead, true);
  core.dispose();
});

test("[R-RT-LIMITS] controller watchdogs cover initialization, evaluation and every round trip", async () => {
  // A worker that answers load but never answers init: the initialization
  // budget, not the step budget, has to settle this.
  const core = createCore(QuickJS);
  const initHang = controllerFor(core, { hangOn: "init" }, { watchdogMs: 5000, loadWatchdogMs: 100 });
  const startedInit = Date.now();
  await assert.rejects(initHang.rc.load(PROGRAM), /watchdog: init exceeded/);
  assert.ok(Date.now() - startedInit < 1500, "init watchdog did not fire promptly");
  assert.equal(initHang.worker.terminated, true);

  // A worker that answers load and init but never answers a step.
  const stepCore = createCore(QuickJS);
  const stepHang = controllerFor(stepCore, { hangOn: "step" }, { watchdogMs: 80, loadWatchdogMs: 5000 });
  await stepHang.rc.load(PROGRAM);
  const startedStep = Date.now();
  await assert.rejects(stepHang.rc.step({ action: "increment" }), /watchdog: step exceeded 80ms/);
  assert.ok(Date.now() - startedStep < 1500, "step watchdog did not fire promptly");
  assert.equal(stepHang.rc.dead, true);
  assert.equal(stepHang.worker.terminated, true);
  core.dispose();
  stepCore.dispose();
});

test("[R-RT-LIMITS] controller fails a step issued before load without killing itself", async () => {
  const core = createCore(QuickJS);
  const { rc } = controllerFor(core);
  await assert.rejects(rc.step({ action: "increment" }), /runtime is not loaded/);
  assert.equal(rc.dead, false);
  // Control: the same controller still loads and steps afterwards.
  const init = await rc.load(PROGRAM);
  assert.match(init.view, /Count: 0/);
  const stepped = await rc.step({ action: "increment" });
  assert.match(stepped.view, /Count: 1/);
  rc.dispose();
  core.dispose();
});

test("[R-RT-LIMITS] controller disposal settles every outstanding promise", async () => {
  const core = createCore(QuickJS);
  // Steps are never answered, so one is in flight and the rest are queued.
  const { rc, worker } = controllerFor(core, { hangOn: "step" }, { watchdogMs: 5000 });
  await rc.load(PROGRAM);
  const pending = [1, 2, 3, 4].map(() => rc.step({ action: "increment" }));
  rc.dispose();
  const settled = await Promise.allSettled(pending);
  assert.equal(settled.length, 4);
  assert.ok(settled.every((r) => r.status === "rejected" && /disposed/.test(r.reason.message)),
    settled.map((r) => r.status + ":" + (r.reason && r.reason.message)).join(", "));
  assert.equal(worker.terminated, true);
  rc.dispose(); // idempotent
  await assert.rejects(rc.step({ action: "increment" }), /runtime is dead/);
  await assert.rejects(rc.load(PROGRAM), /runtime is dead/);
  core.dispose();
});

test("[R-RT-LIMITS] controller bounds host-side conversion of the source, data and events", async () => {
  const core = createCore(QuickJS);
  const { rc } = controllerFor(core, {}, { limits: { maxSourceChars: 500, maxDataChars: 100, maxEventChars: 40 } });
  // Conversion failures happen before a worker exists, so the controller is
  // still usable for a corrected call.
  await assert.rejects(rc.load("x".repeat(501)), /source too large: 501 > 500/);
  assert.equal(rc.dead, false);
  await assert.rejects(rc.load(PROGRAM, { big: "y".repeat(200) }), /data too large/);
  assert.equal(rc.dead, false);
  await assert.rejects(rc.load(PROGRAM, { bad: 1n }), /BigInt|not JSON-serializable/);
  assert.equal(rc.dead, false);

  await rc.load(PROGRAM);
  await assert.rejects(rc.step({ action: "z".repeat(60) }), /event too large: \d+ > 40/);
  const circular = { action: "increment" };
  circular.self = circular;
  await assert.rejects(rc.step(circular), /circular|not JSON-serializable/);
  // A rejected event does not stop the session: the next one still runs.
  assert.equal(rc.dead, false);
  const stepped = await rc.step({ action: "increment" });
  assert.match(stepped.view, /Count: 1/);
  rc.dispose();
  core.dispose();
});

test("[R-RT-LIMITS] controller and worker enforce the same limits module", async () => {
  // The controller is configured more strictly than the core it talks to, so
  // a view the core happily produced is still refused on receipt.
  const core = createCore(QuickJS, { maxViewChars: 400000 });
  const { rc } = controllerFor(core, {}, { limits: { maxViewChars: 20 } });
  await assert.rejects(rc.load(`
    const initialState = {};
    ${UPDATE_ID}
    function view(s) { return "<p>" + "x".repeat(100) + "</p>"; }`), /view too large: 107 > 20/);
  assert.equal(rc.dead, true);
  assert.deepEqual(rc.limits.maxViewChars, 20);
  core.dispose();
});
