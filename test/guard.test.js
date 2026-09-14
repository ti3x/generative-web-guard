// The integrated API, end to end in Node: real QuickJS runs the program, the
// real Lean checker decides, the real policy client wires the private port,
// and only the DOM frame is stood in. Every lifecycle promise must settle,
// every view must take the acceptance path, and nothing may bypass it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { getQuickJS } from "quickjs-emscripten";
import { createGuardWith, GUARD_MAX_PENDING_EVENTS } from "../src/guard.js";
import { createPolicySession } from "../src/policy-client.js";
import { createRuntimeController } from "../src/runtime/controller.js";
import { PROTOCOL_VERSION } from "../src/runtime/protocol.js";
import { createCore } from "../src/runtime/core.js";
import { createFrameReceiver } from "../src/frame-channel.js";
import { isValidated, setClassAllowlist } from "../src/policy.js";
import { isTreeShaped } from "../src/tree.js";
import { CLASSES, leanSkip, realChecker } from "./lean-support.js";
import { portWorker } from "./port-support.js";

const skip = leanSkip();
setClassAllowlist(CLASSES);
const QuickJS = await getQuickJS();
const MANIFEST = { classes: CLASSES, scriptHash: "S", cssHash: "C", script: "", css: "" };
const CONTAINER = { ownerDocument: {} };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// A failing assertion must not leave a Worker or a port open: an open
// MessagePort keeps Node alive and the run would never finish. Every guard the
// harness creates is disposed after the file, whatever its test did.
const live = new Set();
after(() => { for (const guard of live) guard.dispose(); });

// A frame stand-in with the surface createGuard uses: ready, whenBound,
// attachPort (installs the receiver exactly as src/frame.js does), clear,
// destroy, and a way to inject a user event.
function guardFrame({ refuse = false, neverAck = false } = {}) {
  const frame = { rendered: [], bootstraps: 0, destroyed: false, receiver: null, onEvent: null, portBound: false };
  let settleBound = null;
  frame.ready = Promise.resolve({ styleSheets: 1, trustedTypes: true });
  frame.whenBound = () => new Promise((resolve) => { if (frame.portBound) resolve(true); else settleBound = resolve; });
  frame.attachPort = (port, ids) => {
    frame.bootstraps += 1;
    if (frame.receiver) frame.receiver.dispose();
    if (neverAck) {
      // A frame that swallows every command and never answers: the host's
      // request budget is the only thing that can settle the render.
      port.onmessage = () => {};
      port.start?.();
      frame.receiver = { dispose: () => port.close(), stats: { rendered: 0, refused: 0, ignored: 0 } };
      frame.portBound = true;
      if (settleBound) { settleBound(true); settleBound = null; }
      return Promise.resolve(true);
    }
    frame.receiver = createFrameReceiver(port, {
      ...ids,
      onRender: (tree) => {
        if (refuse) return { ok: false, reason: "frame declined" };
        if (!isTreeShaped(tree)) return { ok: false, reason: "malformed renderer tree" };
        frame.rendered.push(tree);
        return { ok: true };
      },
    });
    frame.portBound = true;
    if (settleBound) { settleBound(true); settleBound = null; }
    return Promise.resolve(true);
  };
  frame.clear = () => {};
  frame.destroy = () => { frame.destroyed = true; if (frame.receiver) frame.receiver.dispose(); if (settleBound) settleBound(false); };
  frame.emit = (event) => frame.onEvent && frame.onEvent(event);
  return frame;
}

// The QuickJS Worker stand-in from test/runtime.test.js: the real core, in
// process, behind the real wire protocol.
function quickjsWorker(core) {
  const listeners = { message: [], messageerror: [], error: [] };
  return {
    terminated: false,
    addEventListener: (t, fn) => listeners[t].push(fn),
    terminate() { this.terminated = true; core.dispose(); },
    postMessage(msg) {
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
      setTimeout(() => { if (!this.terminated) listeners.message.forEach((fn) => fn({ data: reply })); }, 0);
    },
  };
}

// Text nodes in document order.
const textOf = (tree) => {
  const out = [];
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (node.kind === "text") out.push(node.text);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out.join("|");
};

const PROGRAM = `
var initialState = { n: 0 };
function update(state, ev) {
  if (ev.action === "boom") throw new Error("boom");
  if (ev.action === "hostile") return { n: -1 };
  return { n: state.n + 1 };
}
function view(state) {
  if (state.n < 0) return '<div class="card">' + '<div>'.repeat(40) + 'x' + '</div>'.repeat(40) + '</div>';
  return '<div class="card"><p>count ' + state.n + '</p><button data-action="inc">+</button></div>';
}`;

async function harness({ frameMode = {}, workerMode = {}, timeouts = {} } = {}) {
  const checker = await realChecker();
  const frame = guardFrame(frameMode);
  const created = { sessions: [], runtimes: [], workers: [], statuses: [] };
  const createGuard = createGuardWith({
    manifest: MANIFEST,
    createFrame: (options) => { frame.onEvent = options.onEvent; frame.hostStatus = options.onStatus; return frame; },
    createPolicySession: (options) => {
      const s = createPolicySession({
        ...options,
        createWorker: () => { const w = portWorker(checker, workerMode); created.workers.push(w); return w; },
        timeouts: { startupMs: 400, requestMs: 400, ...timeouts },
      });
      created.sessions.push(s);
      return s;
    },
    createRuntime: (options) => {
      const r = createRuntimeController({ ...options, createWorker: () => quickjsWorker(createCore(QuickJS)), watchdogMs: 2000, loadWatchdogMs: 5000 });
      created.runtimes.push(r);
      return r;
    },
  });
  const guard = await createGuard({ container: CONTAINER, onStatus: (s) => created.statuses.push(s), timeouts: { channelHandshakeMs: 500 } });
  live.add(guard);
  return { guard, frame, created, kinds: () => created.statuses.map((s) => s.kind) };
}

// --- static documents ---------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] createGuard resolves only with the authority ready, and a static render is acknowledged by the frame", { skip }, async () => {
  const h = await harness();
  assert.deepEqual(h.kinds(), ["ready"]);
  assert.ok(h.guard.checker && h.guard.checker.checkerVersion, "the guard reports which authority it renders through");
  const result = await h.guard.render({ html: `<div class="card"><p>hello</p><script>alert(1)</script></div>` });
  assert.equal(result.status, "rendered", JSON.stringify(result));
  assert.equal(result.generation, 1);
  assert.equal("tree" in result, false, "the API never returns a tree");
  assert.equal(h.frame.rendered.length, 1);
  assert.equal(textOf(h.frame.rendered[0]), "hello");
  assert.ok(isValidated(h.frame.rendered[0]));
  assert.ok(h.kinds().includes("rendered"));
  h.guard.dispose();
});

test("[R-CHECK-ACCEPTANCE] a document the authority refuses is a rejected result and the previous display stays", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ html: `<p class="card">kept</p>` });
  const deep = "<div>".repeat(40) + "x" + "</div>".repeat(40);
  const result = await h.guard.render({ html: deep });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "candidate-rejected");
  assert.equal(h.frame.rendered.length, 1, "nothing new reached the frame");
  assert.equal(textOf(h.frame.rendered[0]), "kept");
  h.guard.dispose();
});

test("[R-FRAME-FIXED-POINT] a frame refusal surfaces as a rejection, never as rendered", { skip }, async () => {
  const h = await harness({ frameMode: { refuse: true } });
  const result = await h.guard.render({ html: `<p class="card">x</p>` });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "frame-refused");
  h.guard.dispose();
});

test("[R-RT-LIMITS] a frame that never acknowledges is bounded by the request budget and the session is replaced", { skip }, async () => {
  const h = await harness({ frameMode: { neverAck: true }, timeouts: { requestMs: 150 } });
  const result = await h.guard.render({ html: `<p class="card">x</p>` });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "timeout");
  assert.ok(h.kinds().includes("session-terminated"));
  assert.equal(h.created.workers[0].terminated, true);
  h.guard.dispose();
});

// --- interactive programs -----------------------------------------------------

test("[R-RT-ISOLATION] a program's first view is what renders, and a frame event advances it through the same path", { skip }, async () => {
  const h = await harness();
  const result = await h.guard.render({ html: `<p class="card">NOT THIS</p>`, program: PROGRAM });
  assert.equal(result.status, "rendered", JSON.stringify(result));
  assert.equal(h.frame.rendered.length, 1);
  assert.equal(textOf(h.frame.rendered[0]), "count 0|+", "the program's view rendered, not the html");
  assert.equal(h.guard.interactive, true);
  h.frame.emit({ type: "click", action: "inc" });
  h.frame.emit({ type: "click", action: "inc" });
  await tick(300);
  assert.equal(h.frame.rendered.length, 3);
  assert.equal(textOf(h.frame.rendered[2]), "count 2|+", "state advanced sequentially");
  h.guard.dispose();
});

test("[R-RT-ISOLATION] a program QuickJS refuses is a rejected result and the html is not rendered as a fallback", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ html: `<p class="card">before</p>` });
  const result = await h.guard.render({ html: `<p class="card">fallback?</p>`, program: "this is not javascript (" });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "program-rejected");
  assert.equal(h.frame.rendered.length, 1, "the supplied html did not quietly render");
  assert.equal(textOf(h.frame.rendered[0]), "before");
  assert.equal(h.guard.interactive, false);
  h.guard.dispose();
});

test("[R-RT-ISOLATION] an event whose update throws stops that program; later events are ignored", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ program: PROGRAM });
  h.frame.emit({ type: "click", action: "boom" });
  await tick(300);
  assert.equal(h.guard.interactive, false);
  assert.ok(h.kinds().includes("runtime-stopped"), h.kinds().join(","));
  h.frame.emit({ type: "click", action: "inc" });
  await tick(100);
  assert.equal(h.frame.rendered.length, 1, "no view after the failure");
  h.guard.dispose();
});

test("[R-CHECK-ACCEPTANCE] a view the authority refuses stops the program that produced it", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ program: PROGRAM });
  h.frame.emit({ type: "click", action: "hostile" }); // the next view is 40 levels deep
  await tick(400);
  assert.equal(h.guard.interactive, false);
  const stop = h.created.statuses.find((s) => s.kind === "runtime-stopped");
  assert.equal(stop.detail.reason.code, "candidate-rejected");
  assert.equal(h.frame.rendered.length, 1);
  h.guard.dispose();
});

// --- lifecycle ------------------------------------------------------------------

test("[R-RT-LIMITS] a replacement supersedes the document in flight and stops its program", { skip }, async () => {
  const h = await harness();
  const first = h.guard.render({ program: PROGRAM });
  const second = h.guard.render({ html: `<p class="card">second</p>` });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(b.status, "rendered");
  assert.ok(["superseded", "rendered"].includes(a.status), a.status);
  assert.equal(h.guard.interactive, false, "the replaced program is not left running");
  assert.equal(textOf(h.frame.rendered.at(-1)), "second");
  h.guard.dispose();
});

test("[R-RT-LIMITS] the event queue is bounded: a flood drops events with a status and the program survives", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ program: PROGRAM });
  for (let i = 0; i < GUARD_MAX_PENDING_EVENTS + 20; i++) h.frame.emit({ type: "click", action: "inc" });
  await tick(1500);
  const dropped = h.created.statuses.filter((s) => s.kind === "event-dropped").length;
  assert.ok(dropped >= 20, `${dropped} dropped`);
  assert.equal(h.guard.interactive, true);
  assert.ok(h.frame.rendered.length >= 2 && h.frame.rendered.length <= GUARD_MAX_PENDING_EVENTS + 1);
  h.guard.dispose();
});

test("[R-CHECK-ACCEPTANCE] clear renders an empty document through the authority and stops interaction", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ program: PROGRAM });
  const result = await h.guard.clear();
  assert.equal(result.status, "rendered");
  assert.deepEqual(h.frame.rendered.at(-1), { kind: "root", children: [] });
  assert.equal(h.guard.interactive, false);
  assert.ok(h.kinds().includes("cleared"));
  h.guard.dispose();
});

test("[R-RT-LIMITS] dispose is idempotent, settles pending work, releases everything, and late events do nothing", { skip }, async () => {
  const h = await harness();
  await h.guard.render({ program: PROGRAM });
  const pendingRender = h.guard.render({ html: `<p class="card">late</p>` });
  h.guard.dispose();
  h.guard.dispose();
  const settled = await pendingRender;
  assert.equal(settled.status, "superseded");
  assert.equal(h.guard.disposed, true);
  assert.equal(h.frame.destroyed, true);
  assert.equal(h.created.sessions[0].alive, false);
  assert.ok(h.created.workers.every((w) => w.terminated));
  assert.equal(h.guard.interactive, false);
  h.frame.emit({ type: "click", action: "inc" });
  await tick(50);
  assert.equal(h.frame.rendered.filter((t) => textOf(t) === "late").length, 0);
  await assert.rejects(() => h.guard.render({ html: "<p></p>" }), /disposed/);
  await assert.rejects(() => h.guard.clear(), /disposed/);
});

test("[R-RT-LIMITS] repeated creation and disposal leaves no live Worker or port behind", { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    const h = await harness();
    const r = await h.guard.render({ html: `<p class="card">${i}</p>` });
    assert.equal(r.status, "rendered");
    h.guard.dispose();
    assert.ok(h.created.workers.every((w) => w.terminated));
    assert.equal(h.frame.destroyed, true);
    assert.equal(h.frame.receiver.stats.rendered, 1);
  }
});

test("[R-RT-LIMITS] a startup failure rejects createGuard with its stage code and tears down what was created", { skip }, async () => {
  const checker = await realChecker();
  const frame = guardFrame();
  const workers = [];
  const createGuard = createGuardWith({
    manifest: MANIFEST,
    createFrame: () => frame,
    createPolicySession: (options) => createPolicySession({
      ...options,
      createWorker: () => { const w = portWorker(checker, { noCheckerReady: true }); workers.push(w); return w; },
      timeouts: { wasmInitMs: 100, startupMs: 200, requestMs: 200 },
    }),
    createRuntime: () => { throw new Error("not reached"); },
  });
  await assert.rejects(() => createGuard({ container: CONTAINER }), (error) => {
    assert.equal(error.name, "StartupError");
    assert.equal(error.code, "wasm-init-timeout");
    return true;
  });
  assert.equal(frame.destroyed, true);
  assert.ok(workers.every((w) => w.terminated));
});

test("[R-RT-LIMITS] API misuse is an exception, not a result", async () => {
  const createGuard = createGuardWith({ manifest: MANIFEST, createFrame: () => ({}), createPolicySession: () => ({}), createRuntime: () => ({}) });
  await assert.rejects(() => createGuard({ container: null }), TypeError);
  await assert.rejects(() => createGuard({ container: CONTAINER, profile: "lax" }), /profile/);
  await assert.rejects(() => createGuard({ container: CONTAINER, onStatus: 42 }), TypeError);
  assert.throws(() => createGuardWith({ manifest: MANIFEST }), TypeError);
});
