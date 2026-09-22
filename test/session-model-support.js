import assert from "node:assert/strict";
import { createPolicySession } from "../src/policy-client.js";
import { createPolicyDispatcher } from "../src/policy-dispatcher.js";
import { createFrameReceiver } from "../src/frame-channel.js";
import { createGuardWith } from "../src/guard.js";
import { POLICY_MESSAGE, POLICY_PROTOCOL_VERSION } from "../src/policy-protocol.js";
import { CLASSES, stubChecker } from "./lean-support.js";
import { scheduler } from "./scheduler-support.js";
import { rng } from "../scripts/lib/fuzz-support.mjs";

export function sessionActions(seed, count = 100) {
  const random = rng(seed);
  const kinds = ["request", "request", "deliver", "deliver", "deliver", "advance", "generation", "error", "bad-ack", "duplicate-ready", "clear", "event"];
  return Array.from({ length: count }, (_, i) => ({
    kind: i > count * .8 && random() < .08 ? "dispose" : kinds[Math.floor(random() * kinds.length)],
    choice: Math.floor(random() * 10000),
  }));
}

export async function runSessionTrace({ seed = 1, mode = "session", actions = sessionActions(seed) } = {}) {
  const clock = scheduler(), workers = [], outcomes = [], sessions = [], frameRenders = [], statuses = [];
  let disposed = false, guard, receiver, frameDead = false, boundResolve, maxRenderedGeneration = -1;
  const heldPorts = new Set();
  const frame = {
    ready: Promise.resolve({ styleSheets: 1 }),
    whenBound: () => new Promise(resolve => { if (receiver) resolve(true); else boundResolve = resolve; }),
    attachPort(port, ids) {
      heldPorts.add(port);
      return new Promise(resolve => clock.queue("frame-bootstrap", () => {
        heldPorts.delete(port);
        if (frameDead) { port.close(); resolve(false); return; }
        receiver?.dispose();
        receiver = createFrameReceiver(port, { ...ids, onRender(tree) {
          frameRenders.push(tree);
          return { ok: true };
        } });
        boundResolve?.(true); resolve(true);
      }));
    },
    destroy() { frameDead = true; receiver?.dispose(); for (const p of heldPorts) p.close(); heldPorts.clear(); boundResolve?.(false); },
  };
  function createWorker() {
    const listeners = { message: new Set(), error: new Set() };
    const number = workers.length;
    const checker = stubChecker((_id, tree) => ({ status: "accepted", tree }));
    const w = {
      terminated: false, checker,
      addEventListener(type, fn) { listeners[type]?.add(fn); },
      removeEventListener(type, fn) { listeners[type]?.delete(fn); },
      terminate() { this.terminated = true; dispatcher.dispose(); for (const list of Object.values(listeners)) list.clear(); },
      emit(data) {
        clock.queue(`host-${number}`, () => { if (!w.terminated) for (const fn of [...listeners.message]) fn({ data }); });
      },
      postMessage(data, ports = []) {
        assert.equal(w.terminated, false, "posting to terminated Worker");
        clock.queue(`worker-${number}`, () => { if (!w.terminated) dispatcher.receive(data, ports); else for (const p of ports) p.close(); });
      },
      error() { for (const fn of [...listeners.error]) fn({ message: "seeded worker error" }); },
    };
    const dispatcher = createPolicyDispatcher({ classes: CLASSES, post(data) {
      assert.equal(w.terminated, false, "Worker sent after termination");
      assert.equal("tree" in data, false, "tree returned to an attached host session");
      if (data.status === "rendered") {
        assert.ok(clock.messages.some(e => e.phase === "delivered" && e.data.kind === "frame/rendered"
          && e.data.requestId === data.requestId && e.data.generation === data.generation
          && e.data.sessionId === data.sessionId && e.data.instanceId === data.instanceId), "rendered before matching ack");
      }
      w.emit(data);
    } });
    w.dispatcher = dispatcher;
    workers.push(w);
    clock.queue(`boot-${number}`, () => { if (!w.terminated) dispatcher.start(); });
    clock.queue(`boot-${number}`, () => { if (!w.terminated) dispatcher.ready(checker); });
    return w;
  }
  function sessionFactory(options) {
    const s = createPolicySession({ ...options, createWorker, classes: CLASSES,
      timeouts: { requestMs: 100, startupMs: 100, channelHandshakeMs: 200, wasmInitMs: 200 } });
    sessions.push(s); return s;
  }
  const pending = [];
  function track(promise) {
    const slot = { settled: 0 };
    outcomes.push(slot);
    pending.push(promise.then(result => {
      slot.settled++;
      assert.ok(["accepted", "rendered", "rejected", "superseded"].includes(result.status));
      assert.equal("tree" in result, false);
      slot.result = result;
    }));
  }
  function inspect() {
    for (const slot of outcomes) assert.ok(slot.settled <= 1, "duplicate terminal outcome");
    for (const session of sessions) assert.ok(session.awaitingCount <= session.pendingCount, "orphan attachment entry");
    // Check commits, not merely host result promises. Transport records retain
    // the request identity even though the renderer accepts only a tree.
    const commits = clock.messages.filter(e => e.phase === "sent" && e.data.kind === "frame/rendered");
    for (const e of commits) {
      assert.ok(e.data.generation >= maxRenderedGeneration, "older generation rendered after newer generation");
      maxRenderedGeneration = e.data.generation;
    }
    // Start from the beginning on each inspection to avoid comparing the first
    // commit against the last commit of the previous inspection.
    maxRenderedGeneration = -1;
  }
  try {
    if (mode === "guard") {
      const makeGuard = createGuardWith({
        manifest: { classes: CLASSES }, createFrame: o => { frame.onEvent = o.onEvent; return frame; },
        createPolicySession: sessionFactory,
        createRuntime: () => ({ dead: false, load: async () => ({ view: "<p>program</p>" }), step: async () => ({ view: "<p>event</p>" }), dispose() { this.dead = true; } }),
      });
      const starting = makeGuard({ container: { ownerDocument: {} }, onStatus: s => statuses.push(s) });
      await clock.microtasks(); await clock.drain(); guard = await starting;
      track(guard.render({ html: "<p>benign-control</p>" }));
    } else {
      sessionFactory({ frame });
      track(sessions[0].preprocess("<p>benign-control</p>"));
    }
    await clock.drain();
    assert.equal(outcomes[0].result.status, "rendered", "benign control did not render");
    for (const action of actions) {
      const session = sessions[0];
      switch (action.kind) {
        case "request":
          if (!disposed) track(mode === "guard"
            ? guard.render(action.choice % 5 === 0 ? { program: "fixture" } : { html: `<p>${action.choice}</p>` })
            : session.preprocess(`<p>${action.choice}</p>`));
          break;
        case "generation": if (!disposed && mode === "session") session.nextGeneration(); break;
        case "clear": if (!disposed && mode === "guard") track(guard.clear()); break;
        case "event": frame.onEvent?.({ type: "click", action: "next" }); break;
        case "deliver": await clock.deliver(action.choice); break;
        case "advance": await clock.advance(action.choice % 150); break;
        case "error": workers.at(-1)?.error(); break;
        case "bad-ack": clock.corruptAck(); break;
        case "duplicate-ready": if (!workers.at(-1)?.terminated) workers.at(-1)?.emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready }); break;
        case "dispose": disposed = true; if (guard) guard.dispose(); else { session.dispose(); frame.destroy(); } break;
        default: throw new Error(`unknown session action ${action.kind}`);
      }
      await clock.microtasks(); inspect();
    }
    if (guard) guard.dispose(); else { sessions[0].dispose(); frame.destroy(); }
    disposed = true;
    await clock.drain(); await clock.advance(1000); await clock.drain();
    await Promise.all(pending);
    inspect();
    assert.ok(outcomes.every(s => s.settled === 1), "unsettled operation");
    assert.ok(sessions.every(s => s.pendingCount === 0 && s.awaitingCount === 0 && !s.alive), "session not cleaned");
    assert.ok(workers.every(w => w.terminated && w.dispatcher.pendingCount === 0), "Worker not cleaned");
    assert.ok(clock.ports.every(p => p.closed), "MessagePort leaked");
    assert.equal(clock.timerCount, 0, "timer leaked");
    return { seed, mode, actions: actions.length, operations: outcomes.length, workers: workers.length, renders: frameRenders.length };
  } finally {
    for (const s of sessions) s.dispose(); frame.destroy();
    for (const w of workers) if (!w.terminated) w.terminate();
    clock.restore();
  }
}
