import { test } from "node:test";
import assert from "node:assert/strict";
import { getQuickJS } from "quickjs-emscripten";
import { createCore } from "../src/runtime/core.js";
import { createRuntimeController } from "../src/runtime/controller.js";

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

// Controller with an in-process fake worker driving the real core.
function fakeWorker(core, { hang = false } = {}) {
  const listeners = { message: [], error: [] };
  return {
    addEventListener: (t, fn) => listeners[t].push(fn),
    terminate() { this.terminated = true; },
    postMessage(msg) {
      if (hang) return;
      let reply;
      try {
        let result;
        if (msg.type === "load") { core.load(msg.source, msg.data ?? null); result = { ok: true }; }
        else if (msg.type === "init") result = core.init();
        else result = core.step(msg.state, msg.event);
        reply = { id: msg.id, ok: true, result };
      } catch (err) {
        reply = { id: msg.id, ok: false, error: err.message };
      }
      setTimeout(() => listeners.message.forEach((fn) => fn({ data: reply })), 0);
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
