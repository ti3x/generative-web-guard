// Per-stage startup timeouts and startup error codes.
//
// The point of these tests is that each of the four startup stages -- worker
// creation, the channel handshake, Wasm init, and the frame bootstrap -- fails
// with its OWN code, and that the code names something the host can change.
// Three of the underlying browser failures produce no CSP violation report at
// all (spike/policy-worker-feasibility.md N3, N8, and the cross-origin Worker
// case N2), so a single aggregate "startup failed" would leave a host with
// nothing to act on.
//
// These are unit tests of the codes and the plumbing. The cross-engine
// evidence that the codes are actually reachable under a real CSP lives in
// scripts/browser-check.mjs, which runs the demo under
// scripts/serve.mjs ?cspOmit=... on Chromium, Firefox and WebKit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  STARTUP_ERRORS,
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  STARTUP_WARNINGS,
  StartupError,
  classifyStartupFailure,
  createBlobWorker,
  withStageTimeout,
} from "../src/startup.js";
import { createSandboxFrame } from "../src/host.js";
import { createPolicySession } from "../src/policy-client.js";
import { createRuntimeController } from "../src/runtime/controller.js";
import { POLICY_MESSAGE, POLICY_PROTOCOL_VERSION } from "../src/policy-protocol.js";
import { PROTOCOL_VERSION } from "../src/runtime/protocol.js";
import { setClassAllowlist } from "../src/policy.js";

setClassAllowlist(["card", "muted"]);

const MANIFEST = { script: "", css: "", scriptHash: "SCRIPTHASH", cssHash: "CSSHASH" };

// --- the code table itself --------------------------------------------------

test("[R-RT-LIMITS] every startup code names a known stage and an actionable fix", () => {
  const stages = new Set(Object.values(STARTUP_STAGES));
  assert.equal(stages.size, 4, "there are exactly four startup stages");
  for (const [code, entry] of Object.entries(STARTUP_ERRORS)) {
    assert.ok(stages.has(entry.stage), `${code}: unknown stage ${entry.stage}`);
    assert.ok(entry.hint.length > 40, `${code}: hint is not actionable`);
  }
  // Each stage must be reachable by at least one code, or that stage has no
  // diagnosis at all.
  for (const stage of stages) {
    assert.ok(
      Object.values(STARTUP_ERRORS).some((entry) => entry.stage === stage),
      `no startup code covers stage ${stage}`,
    );
  }
  // Separate budgets, not one aggregate.
  assert.equal(Object.keys(STARTUP_TIMEOUTS).length, 4);
  for (const value of Object.values(STARTUP_TIMEOUTS)) assert.ok(value > 0);
});

test("[R-FRAME-CSP-SINKS] the frame bootstrap message names both hashes and claims no cause", () => {
  // N8: the host receives NO securitypolicyviolation for a CSP failure inside
  // a srcdoc frame on any engine, so this message must not assert a cause.
  const hint = STARTUP_ERRORS["frame-bootstrap-timeout"].hint;
  assert.match(hint, /script-src/);
  assert.match(hint, /style-src/);
  assert.match(hint, /cannot be determined/);
  assert.ok(!/because/.test(hint), "the frame bootstrap hint must not claim a cause");
});

test("[R-FRAME-CSP-SINKS] no startup hint offers 'unsafe-eval' or a looser frame as a remedy", () => {
  for (const [code, entry] of Object.entries({ ...STARTUP_ERRORS })) {
    const text = entry.hint;
    // A hint may NAME 'unsafe-inline' only to say it is ignored -- which is
    // the load-bearing fact for a nonce host, whose policy usually carries it
    // and whose frame then never starts. It must never be offered as a fix,
    // so the mention has to come with "is IGNORED", the same shape the
    // 'unsafe-eval' rule below uses.
    if (/'unsafe-inline'/.test(text)) {
      assert.match(text, /'unsafe-inline' is IGNORED/, `${code} mentions 'unsafe-inline' without saying it is ignored`);
      assert.ok(!/add 'unsafe-inline'|allow 'unsafe-inline'/i.test(text), `${code} offers 'unsafe-inline' as a remedy`);
    }
    assert.ok(!/allow-same-origin/.test(text), `${code} mentions allow-same-origin`);
    // 'unsafe-eval' appears exactly once, in the csp-wasm-unsafe-eval hint,
    // and only to forbid it.
    if (/(?<!wasm-)unsafe-eval/.test(text)) {
      assert.match(text, /Do NOT use 'unsafe-eval'/, `${code} mentions 'unsafe-eval' without forbidding it`);
    }
  }
  assert.ok(Object.keys(STARTUP_WARNINGS).includes("frame-style-hash-missing"));
});

test("[R-RT-LIMITS] StartupError carries bounded plain data", () => {
  const error = new StartupError("csp-worker-blob", { detail: "x".repeat(1000), timeoutMs: 5, component: "policy-worker" });
  const json = error.toJSON();
  assert.equal(json.code, "csp-worker-blob");
  assert.equal(json.stage, STARTUP_STAGES.workerCreate);
  assert.equal(json.detail.length, 300);
  assert.equal(json.component, "policy-worker");
  assert.match(error.message, /csp-worker-blob \(stage: worker-create\)/);
  assert.equal(error.name, "StartupError");
});

// --- classification: only what the spike observed ---------------------------

test("[R-RT-LIMITS] observed engine messages map to the directive that has to change", () => {
  // Chromium 140, missing 'wasm-unsafe-eval'.
  assert.equal(
    classifyStartupFailure(STARTUP_STAGES.wasmInit,
      new Error("CompileError: WebAssembly.Module(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script")),
    "csp-wasm-unsafe-eval",
  );
  // Chromium 140, cross-origin Worker URL: structurally impossible, no CSP fix.
  assert.equal(
    classifyStartupFailure(STARTUP_STAGES.workerCreate,
      new Error("Failed to construct 'Worker': Script at 'http://cdn/worker.js' cannot be accessed from origin 'http://host'")),
    "csp-worker-blob",
  );
  // worker-src without blob:.
  assert.equal(
    classifyStartupFailure(STARTUP_STAGES.workerCreate,
      new Error("Refused to create a worker from 'blob:http://host/abc' because it violates the Content Security Policy directive")),
    "csp-worker-blob",
  );
  // Dynamic import of the CDN payload refused (script-src-elem).
  assert.equal(
    classifyStartupFailure(STARTUP_STAGES.workerCreate, new Error("Failed to fetch dynamically imported module")),
    "csp-cdn-script-src",
  );
});

test("[R-RT-LIMITS] a generated program that does not compile is not a startup failure", () => {
  // The QuickJS load round trip both instantiates Wasm and compiles the
  // program. Misreading a bad program as a CSP problem would send a host to
  // change a header it does not need to change.
  for (const message of [
    "SyntaxError: unexpected token",
    "program must export initialState",
    "TypeError: WebAssembly is not defined",
    "interface check failed: view is not a function",
  ]) {
    assert.equal(classifyStartupFailure(STARTUP_STAGES.wasmInit, new Error(message), null), null, message);
  }
});

test("[R-RT-LIMITS] withStageTimeout raises the stage's code and runs its cleanup", async () => {
  let cleaned = false;
  await assert.rejects(
    withStageTimeout(new Promise(() => {}), {
      code: "channel-handshake-timeout",
      timeoutMs: 5,
      component: "policy-worker",
      onTimeout: () => { cleaned = true; },
    }),
    (error) => {
      assert.equal(error.code, "channel-handshake-timeout");
      assert.equal(error.stage, STARTUP_STAGES.channelHandshake);
      assert.equal(error.timeoutMs, 5);
      return true;
    },
  );
  assert.equal(cleaned, true);
});

// --- worker-create stage ----------------------------------------------------

test("[R-RT-ISOLATION] createBlobWorker refuses a missing platform instead of falling back to a script URL", () => {
  // Node has no Worker/Blob globals. The point is that there is no fallback:
  // a network Worker URL would not inherit the document CSP, and a
  // cross-origin one cannot work at all.
  assert.throws(() => createBlobWorker("self.onmessage=()=>{}"), (error) => {
    assert.equal(error.code, "worker-blob-unsupported");
    assert.equal(error.stage, STARTUP_STAGES.workerCreate);
    return true;
  });
  assert.throws(() => createBlobWorker(""), /non-empty source string/);
});

test("[R-RT-LIMITS] a refused blob: Worker settles the policy request with csp-worker-blob", async () => {
  const session = createPolicySession({
    createWorker: () => {
      // What Chromium does when worker-src omits blob:.
      throw new DOMException
        ? new Error("Refused to create a worker from 'blob:http://host/x' because it violates the Content Security Policy directive: \"worker-src 'self'\"")
        : new Error("blob refused");
    },
    classes: ["card"],
  });
  const result = await session.preprocess('<p class="muted">x</p>');
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "csp-worker-blob");
  assert.equal(result.reason.stage, STARTUP_STAGES.workerCreate);
  assert.match(result.reason.hint, /worker-src/);
  await assert.rejects(session.whenReady(), (error) => {
    assert.equal(error.code, "csp-worker-blob");
    return true;
  });
  session.dispose();
});

test("[R-RT-LIMITS] the QuickJS controller raises csp-worker-blob from worker creation", async () => {
  const rc = createRuntimeController({
    createWorker: () => { throw new StartupError("csp-worker-blob"); },
  });
  await assert.rejects(rc.load("const initialState=0;function update(s){return s}function view(){return ''}"), (error) => {
    assert.equal(error.name, "StartupError");
    assert.equal(error.code, "csp-worker-blob");
    assert.equal(error.stage, STARTUP_STAGES.workerCreate);
    return true;
  });
  assert.equal(rc.dead, true);
});

// --- channel-handshake stage ------------------------------------------------

function silentWorker() {
  const listeners = { message: new Set(), error: new Set() };
  return {
    terminated: false,
    posted: [],
    addEventListener(type, fn) { listeners[type]?.add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    terminate() { this.terminated = true; },
    postMessage(msg) { this.posted.push(msg); },
    emitError(message) { for (const fn of [...listeners.error]) fn(message === undefined ? {} : { message }); },
    emitReady() {
      for (const fn of [...listeners.message]) {
        fn({ data: { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready } });
      }
    },
  };
}

test("[R-RT-LIMITS] a Worker that never answers fails the channel-handshake stage with its own code", async () => {
  const workers = [];
  const terminations = [];
  const session = createPolicySession({
    createWorker: () => { const w = silentWorker(); workers.push(w); return w; },
    classes: ["card"],
    // Long request budget: the handshake stage, not the request timer, must
    // be what settles this. That separation is the whole point.
    timeouts: { requestMs: 60_000, startupMs: 60_000, channelHandshakeMs: 20 },
    onTerminated: (event) => terminations.push(event),
  });
  const pending = session.preprocess('<p class="muted">x</p>');
  await assert.rejects(session.whenReady(), (error) => {
    assert.equal(error.code, "channel-handshake-timeout");
    assert.equal(error.stage, STARTUP_STAGES.channelHandshake);
    return true;
  });
  const result = await pending;
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "session-terminated");
  assert.equal(result.reason.detail, "channel-handshake-timeout");
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(terminations.map((e) => e.code), ["channel-handshake-timeout"]);
  session.dispose();
});

test("[R-RT-LIMITS] an opaque Worker error event before the handshake says what to check", async () => {
  const workers = [];
  const terminations = [];
  const session = createPolicySession({
    createWorker: () => { const w = silentWorker(); workers.push(w); return w; },
    classes: ["card"],
    timeouts: { requestMs: 60_000, startupMs: 60_000, channelHandshakeMs: 60_000 },
    onTerminated: (event) => terminations.push(event),
  });
  const pending = session.preprocess('<p class="muted">x</p>');
  // Firefox and WebKit fire an error event with no message at all for a
  // Worker the policy refused; a bare "worker error" would be useless.
  workers[0].emitError(undefined);
  await assert.rejects(session.whenReady(), (error) => {
    assert.equal(error.code, "worker-startup-error");
    return true;
  });
  const result = await pending;
  assert.equal(result.reason.code, "session-terminated");
  assert.equal(result.reason.detail, "worker-startup-error");
  assert.equal(terminations[0].code, "worker-startup-error");
  assert.match(terminations[0].detail, /blob:/);
  session.dispose();
});

test("[R-RT-LIMITS] whenReady resolves once the Worker completes the handshake", async () => {
  const workers = [];
  const session = createPolicySession({
    createWorker: () => { const w = silentWorker(); workers.push(w); return w; },
    classes: ["card"],
    timeouts: { requestMs: 60_000, channelHandshakeMs: 60_000 },
  });
  const pending = session.preprocess('<p class="muted">x</p>');
  workers[0].emitReady();
  const ready = await session.whenReady();
  assert.equal(typeof ready.sessionId, "string");
  session.dispose();
  await pending;
});

// --- wasm-init stage --------------------------------------------------------

function replyingWorker(reply) {
  const listeners = { message: [], messageerror: [], error: [] };
  return {
    terminated: false,
    addEventListener: (t, fn) => listeners[t].push(fn),
    terminate() { this.terminated = true; },
    postMessage(msg) {
      setTimeout(() => listeners.message.forEach((fn) => fn({ data: { v: PROTOCOL_VERSION, id: msg.id, ...reply(msg) } })), 0);
    },
  };
}

const OK_PROGRAM = "const initialState=0;function update(s){return s}function view(){return ''}";

test("[R-RT-LIMITS] a CompileError relayed out of the blob: Worker becomes csp-wasm-unsafe-eval", async () => {
  // A blob: Worker inherits the host document's policy, so this is how a
  // missing 'wasm-unsafe-eval' actually presents itself: not as a violation
  // event on the host, but as an error reported back over the port.
  const rc = createRuntimeController({
    createWorker: () => replyingWorker(() => ({
      ok: false,
      error: "CompileError: WebAssembly.Module(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script",
    })),
  });
  await assert.rejects(rc.load(OK_PROGRAM), (error) => {
    assert.equal(error.name, "StartupError");
    assert.equal(error.code, "csp-wasm-unsafe-eval");
    assert.equal(error.stage, STARTUP_STAGES.wasmInit);
    assert.match(error.hint, /'wasm-unsafe-eval'/);
    assert.match(error.hint, /Do NOT use 'unsafe-eval'/);
    return true;
  });
  assert.equal(rc.dead, true);
});

test("[R-RT-LIMITS] a stalled Wasm init has its own budget and its own code", async () => {
  const rc = createRuntimeController({
    createWorker: () => ({
      terminated: false,
      addEventListener() {},
      terminate() { this.terminated = true; },
      postMessage() {},
    }),
    // The overall load watchdog stays long: the wasm-init stage must be what
    // fires, so the code points at Wasm rather than at "load".
    loadWatchdogMs: 60_000,
    wasmInitMs: 20,
  });
  await assert.rejects(rc.load(OK_PROGRAM), (error) => {
    assert.equal(error.code, "wasm-init-timeout");
    assert.equal(error.stage, STARTUP_STAGES.wasmInit);
    assert.equal(error.timeoutMs, 20);
    return true;
  });
});

test("[R-RT-LIMITS] a program QuickJS refuses keeps its own error, not a startup code", async () => {
  const rc = createRuntimeController({
    createWorker: () => replyingWorker(() => ({ ok: false, error: "program does not define view" })),
  });
  await assert.rejects(rc.load(OK_PROGRAM), (error) => {
    assert.notEqual(error.name, "StartupError");
    assert.equal(error.message, "program does not define view");
    return true;
  });
});

// --- frame-bootstrap stage --------------------------------------------------

test("[R-FRAME-CSP-SINKS] a frame that never bootstraps fails with both required hashes", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  const statuses = [];
  const frame = createSandboxFrame({
    container: dom.window.document.getElementById("c"),
    manifest: MANIFEST,
    onStatus: (s) => statuses.push(s),
    startupTimeoutMs: 20,
  });
  await assert.rejects(frame.ready, (error) => {
    assert.equal(error.code, "frame-bootstrap-timeout");
    assert.equal(error.stage, STARTUP_STAGES.frameBootstrap);
    assert.equal(error.component, "frame");
    // The one signal that exists is the timeout, so the message has to carry
    // both hashes itself.
    assert.match(error.detail, /sha256-SCRIPTHASH/);
    assert.match(error.detail, /sha256-CSSHASH/);
    return true;
  });
  const failure = statuses.find((s) => s.kind === "startup-failed");
  assert.equal(failure.detail.code, "frame-bootstrap-timeout");
  frame.destroy();
});

test("[R-FRAME-CSP-SINKS] a frame with no stylesheet warns rather than failing", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  const { window } = dom;
  const statuses = [];
  const frame = createSandboxFrame({
    container: window.document.getElementById("c"),
    manifest: MANIFEST,
    onStatus: (s) => statuses.push(s),
    startupTimeoutMs: 5_000,
  });
  // The frame reports facts about itself that the host cannot see: its own
  // CSP violations are invisible here, but "my stylesheet did not apply" is
  // observable from inside and means the host style-src lacks the style hash.
  window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "ready", styleSheets: 0, trustedTypes: false },
    source: frame.element.contentWindow,
    origin: "null",
  }));
  const info = await frame.ready;
  assert.equal(info.styleSheets, 0);
  assert.equal(info.trustedTypes, false);
  const warning = statuses.find((s) => s.kind === "startup-warning");
  assert.equal(warning.detail.code, "frame-style-hash-missing");
  assert.match(warning.detail.detail, /sha256-CSSHASH/);
  assert.equal(statuses.some((s) => s.kind === "startup-failed"), false);
  frame.destroy();
});

test("[R-FRAME-CSP-SINKS] the frame reports whether the engine gave it Trusted Types", async () => {
  // Firefox 141 does not implement require-trusted-types-for/trusted-types,
  // so window.trustedTypes is undefined inside the frame there and the sink
  // hardening in src/frame.js is the only equivalent. The frame says which it
  // got rather than letting the host assume uniform coverage.
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  const { window } = dom;
  const frame = createSandboxFrame({
    container: window.document.getElementById("c"),
    manifest: MANIFEST,
    startupTimeoutMs: 5_000,
  });
  window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "ready", styleSheets: 1, trustedTypes: true },
    source: frame.element.contentWindow,
    origin: "null",
  }));
  assert.deepEqual(await frame.ready, { styleSheets: 1, trustedTypes: true });
  frame.destroy();
});
