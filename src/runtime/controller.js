// Host-side runtime controller. Owns the program state as JSON text, drives
// the QuickJS worker one request at a time, enforces watchdogs, and tags
// everything with a generation number so stale results are dropped.
//
// This is the receive boundary. Every reply is validated against
// ./protocol.js — protocol version, exact message shape, the id of the
// request that is actually outstanding, and the length of every field —
// before any state is committed or any view is handed on towards markup
// validation. The worker checks the same rules on the way out. A reply that
// fails either check stops the session; it is never coerced into something
// renderable.
//
// On any failure the runtime is marked dead: interaction stops, the caller
// keeps its last validated view, and the trusted UI shows the failure. There
// is deliberately no fallback to running generated code anywhere else.
//
// Every promise this controller hands out settles exactly once. A malformed,
// stale or duplicated reply settles the job it belongs to instead of leaving
// it for the watchdog; disposal settles everything still outstanding; and a
// step issued before load fails immediately instead of reaching for a worker
// that does not exist yet.

import { PROTOCOL_VERSION, checkReply, errorText, resolveLimits } from "./protocol.js";
import {
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  StartupError,
  classifyStartupFailure,
} from "../startup.js";

// watchdogMs bounds a single step round trip. loadWatchdogMs bounds the whole
// initialization: worker startup, Wasm instantiation, host-side conversion of
// the dataset, program load and the first init round trip all share it, and
// each round trip gets whatever is left of it. On first use in a cold browser
// that sequence can take several seconds.
//
// STARTUP STAGES. Inside that overall budget, load() separates the two stages
// that fail for different reasons and need different fixes:
//
//   worker-create  createWorker() itself. A blob: Worker refused by the host
//                  policy fires an OPAQUE ERROR EVENT on all three engines --
//                  Chromium 140 included; it does not throw synchronously,
//                  measured in spike/nonce/ -- so that case arrives at the
//                  handshake stage as `worker-startup-error`, whose hint names
//                  blob:. `csp-worker-blob` is still raised from a synchronous
//                  throw, which is what a cross-origin Worker URL does.
//   wasm-init      the `load` round trip, which is what forces QuickJS to
//                  compile its embedded Wasm inside the Worker. A blob:
//                  Worker inherits the host document's CSP, so a missing
//                  'wasm-unsafe-eval' surfaces here as a CompileError
//                  relayed back over the port -> `csp-wasm-unsafe-eval`.
//                  A stall instead gives `wasm-init-timeout`.
//                  (WebKit 26 refuses `WebAssembly.instantiate` without the
//                  token -- the form QuickJS uses -- but does NOT gate
//                  `new WebAssembly.Module()` or `WebAssembly.compile()`. So
//                  this stage does fail there, and no claim of the form "the
//                  policy prevents Wasm compilation" holds on WebKit. See
//                  docs/csp.md.)
//
// Both raise a StartupError with a code and a hint naming the directive, not
// a generic "runtime failed". See src/startup.js and docs/csp.md.
//
// limits must match the limits the worker's core was built with; both sides
// default to the protocol's defaults, and the stricter side rejects first if
// they are ever configured apart.
export function createRuntimeController({
  createWorker,
  watchdogMs = 1500,
  loadWatchdogMs = 15000,
  wasmInitMs = STARTUP_TIMEOUTS.wasmInitMs,
  maxQueue = 32,
  limits = {},
  onDead,
}) {
  const L = resolveLimits(limits);
  let worker = null;
  let nextId = 1;
  let generation = 0;
  let stateJson = null;
  let dead = false;
  let ready = false;
  let inFlight = null; // { id, type, resolve, reject, timer }
  const queue = []; // pending step requests
  let dropped = 0;

  function markDead(reason) {
    if (dead) return;
    dead = true;
    // Bumping the generation invalidates any result still in a continuation,
    // so a reply that was already accepted cannot commit state after death.
    generation++;
    const error = new Error(reason);
    if (inFlight) {
      const active = inFlight;
      inFlight = null;
      clearTimeout(active.timer);
      active.reject(error);
    }
    while (queue.length) queue.shift().reject(error);
    if (worker) {
      worker.terminate();
      worker = null;
    }
    onDead && onDead(reason);
  }

  // One request at a time. A second concurrent request would orphan the
  // first one's promise and its watchdog, so it is refused rather than
  // silently replacing it.
  function request(type, payload, budgetMs) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(new Error("runtime is dead"));
      if (!worker) return reject(new Error("runtime is not loaded"));
      if (inFlight) return reject(new Error("runtime is busy"));
      const budget = Math.max(1, Math.floor(budgetMs));
      const id = nextId++;
      const timer = setTimeout(() => markDead(`watchdog: ${type} exceeded ${budget}ms`), budget);
      inFlight = { id, type, resolve, reject, timer };
      try {
        worker.postMessage({ v: PROTOCOL_VERSION, id, type, ...payload });
      } catch (err) {
        // markDead settles this request; it is already the in-flight one.
        markDead(`postMessage failed: ${errorText(err, L.maxDiagnosticChars)}`);
      }
    });
  }

  function onMessage(e) {
    const active = inFlight;
    const problem = checkReply(e.data, { id: active?.id, type: active?.type, limits: L });
    if (problem) {
      // Malformed, stale, duplicate, mismatched or oversized: a protocol
      // failure, not a result. markDead settles the active job now rather
      // than leaving it to time out, and stops the session.
      markDead(`protocol: ${problem}`);
      return;
    }
    const msg = e.data;
    inFlight = null;
    clearTimeout(active.timer);
    if (msg.ok) active.resolve(msg.result);
    else active.reject(new Error(msg.error));
  }

  // One step at a time. The next job starts only after this one's state has
  // been committed, so every step sees the state produced by the previous one.
  function pump() {
    while (!dead && !inFlight && queue.length > 0) {
      const job = queue.shift();
      const gen = generation;
      let eventJson;
      try {
        eventJson = JSON.stringify(job.event);
        if (typeof eventJson !== "string") throw new Error("event is not JSON-serializable");
        if (eventJson.length > L.maxEventChars) {
          throw new Error(`event too large: ${eventJson.length} > ${L.maxEventChars}`);
        }
      } catch (err) {
        // Host-side conversion failed: the caller handed over an event that
        // cannot cross the boundary. Reject that event and keep the session
        // alive, then take the next one.
        job.reject(err instanceof Error ? err : new Error("event is not JSON-serializable"));
        continue;
      }
      request("step", { state: stateJson, event: eventJson }, watchdogMs)
        .then((result) => {
          if (dead) return job.reject(new Error("runtime is dead"));
          if (gen !== generation) return job.reject(new Error("stale generation"));
          // Shape and length were validated in onMessage against the shared
          // protocol definition; committing is all that is left.
          stateJson = result.state;
          job.resolve({ view: result.view, generation: gen });
        })
        .catch((err) => {
          markDead(err.message);
          job.reject(err);
        })
        .finally(pump);
      return;
    }
  }

  return {
    // data: optional host-owned dataset (any JSON-serializable value). It is
    // serialized here, so nothing but JSON text reaches the worker, and the
    // program sees it as a frozen global named data.
    async load(source, data = undefined) {
      if (dead) throw new Error("runtime is dead");
      if (worker) throw new Error("already loaded");
      const deadline = Date.now() + loadWatchdogMs;
      const remaining = () => deadline - Date.now();
      // Synchronous host conversion cannot be preempted by a timer, so it is
      // bounded by size first and charged against the same deadline once it
      // finishes. These failures happen before a worker exists, so the
      // controller stays usable for a corrected call.
      if (typeof source !== "string") throw new Error("source must be a string");
      if (source.length > L.maxSourceChars) {
        throw new Error(`source too large: ${source.length} > ${L.maxSourceChars}`);
      }
      let dataJson = null;
      if (data !== undefined) {
        dataJson = JSON.stringify(data);
        if (typeof dataJson !== "string") throw new Error("data is not JSON-serializable");
        if (dataJson.length > L.maxDataChars) {
          throw new Error(`data too large: ${dataJson.length} > ${L.maxDataChars}`);
        }
      }
      if (remaining() <= 0) throw new Error(`watchdog: conversion exceeded ${loadWatchdogMs}ms`);
      // ---- stage: worker-create ----------------------------------------
      try {
        worker = createWorker();
      } catch (error) {
        worker = null;
        const startupError = error instanceof StartupError
          ? error
          : new StartupError(
            classifyStartupFailure(STARTUP_STAGES.workerCreate, error, "csp-worker-blob"),
            { component: "quickjs-worker", detail: error && error.message ? error.message : String(error) },
          );
        markDead(startupError.message);
        throw startupError;
      }
      worker.addEventListener("message", onMessage);
      worker.addEventListener("messageerror", () => markDead("worker reply could not be deserialized"));
      // On Firefox and WebKit a Worker the policy refused fires an error event
      // with no message. Say what that most likely means instead of "worker
      // error"; before the first reply there is nothing else to go on.
      worker.addEventListener("error", () => markDead(ready
        ? "worker error"
        : "worker error during startup (Firefox/WebKit report no message); check that the host policy's worker source directive contains blob:"));
      generation++;
      // ---- stage: wasm-init --------------------------------------------
      // The load round trip is what forces QuickJS to instantiate its
      // embedded Wasm, so this budget and this code belong to that stage.
      const wasmBudget = Math.max(1, Math.min(remaining(), wasmInitMs));
      try {
        await request("load", { source, data: dataJson }, wasmBudget);
      } catch (err) {
        // The load round trip carries two different kinds of failure. A CSP
        // or platform failure gets a startup code; a generated program that
        // does not compile is ordinary content rejection and keeps its own
        // error, because calling that a startup error would point the host at
        // a header it does not need to change.
        const timedOut = /watchdog/.test(String(err && err.message));
        const code = classifyStartupFailure(STARTUP_STAGES.wasmInit, err, timedOut ? "wasm-init-timeout" : null);
        if (code === null) {
          markDead(err.message);
          throw err;
        }
        const startupError = new StartupError(code, {
          stage: STARTUP_STAGES.wasmInit,
          component: "quickjs-worker",
          timeoutMs: wasmBudget,
          detail: err && err.message ? err.message : String(err),
        });
        markDead(startupError.message);
        throw startupError;
      }
      try {
        if (remaining() <= 0) throw new Error(`watchdog: load exceeded ${loadWatchdogMs}ms`);
        const result = await request("init", {}, remaining());
        stateJson = result.state;
        ready = true;
        return { view: result.view, generation };
      } catch (err) {
        markDead(err.message);
        throw err;
      }
    },
    // Queue a plain-data event. Resolves with the next view string. Queue
    // latency is bounded too: at most maxQueue steps of watchdogMs each.
    step(event) {
      return new Promise((resolve, reject) => {
        if (dead) return reject(new Error("runtime is dead"));
        if (!ready) return reject(new Error("runtime is not loaded: call load() first"));
        if (queue.length >= maxQueue) {
          dropped++;
          return reject(new Error("event queue full"));
        }
        queue.push({ event, resolve, reject });
        pump();
      });
    },
    // Idempotent. Settles every outstanding promise, stops the watchdog and
    // terminates the worker; a late reply can neither commit state nor
    // restart the session.
    dispose() {
      markDead("disposed");
    },
    get dead() { return dead; },
    get generation() { return generation; },
    get droppedEvents() { return dropped; },
    get limits() { return L; },
  };
}
