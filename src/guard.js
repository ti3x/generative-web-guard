// The integrated API: one object that owns execution, preprocessing, Lean
// acceptance, rendering, events and cleanup, so an application never writes
// the glue between them -- and never gets a chance to skip a step.
//
//   const guard = await createGuard({ container, onStatus });
//   const result = await guard.render({ html, program, data });
//   await guard.clear();
//   guard.dispose();
//
// WHAT A CONSUMER CANNOT DO THROUGH THIS API
//
//   * obtain a raw generated view or an accepted tree;
//   * mount anything into the frame itself;
//   * supply a checker, a renderer, or a "skip validation" flag;
//   * turn a status callback into a host capability for the guest: status data
//     is bounded plain data about what happened, never a handle to anything.
//
// WHO DOES WHAT
//
//   QuickJS Worker      runs the generated program; the only thing that ever
//                       leaves it is a view STRING (src/runtime/controller.js).
//   policy Worker       parses that string, builds the candidate, asks Lean,
//                       and on acceptance delivers Lean's tree straight to the
//                       frame over the private port (src/policy-client.js,
//                       src/frame-protocol.js). This object never holds a tree.
//   frame               renders only what arrives over that port
//                       (src/host.js, src/frame.js).
//
// `createGuardWith(factories)` binds those three pieces; the shipped entry
// point (src/cdn-full.js) binds the embedded Worker payloads and the built
// frame manifest, and exports the result as `createGuard`. The factories are
// not a consumer surface: they exist so the whole lifecycle runs under Node
// with the real Lean checker and real QuickJS in tests.

import { STARTUP_TIMEOUTS, StartupError, withStageTimeout } from "./startup.js";

/** Events the guard will hold for an interactive program before dropping new ones. */
export const GUARD_MAX_PENDING_EVENTS = 32;

const MAX_DETAIL = 300;
const bounded = (value) => (typeof value === "string" ? value.slice(0, MAX_DETAIL) : undefined);

/** A reason object as it leaves this module: a code and bounded plain fields. */
function boundedReason(reason) {
  if (!reason || typeof reason !== "object") return { code: "rejected" };
  const out = { code: typeof reason.code === "string" ? reason.code.slice(0, 80) : "rejected" };
  for (const key of ["limit", "limitValue", "observed", "depth", "stage"]) {
    if (reason[key] !== undefined && (typeof reason[key] === "string" || typeof reason[key] === "number")) out[key] = reason[key];
  }
  const detail = bounded(reason.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}

/**
 * @param {object} factories
 * @param {(options:object)=>object} factories.createFrame          src/host.js createSandboxFrame
 * @param {(options:object)=>object} factories.createPolicySession  src/policy-client.js, Worker already bound
 * @param {(options:object)=>object} factories.createRuntime        src/runtime/controller.js, Worker already bound
 * @param {object} factories.manifest                                the built frame manifest
 */
export function createGuardWith(factories) {
  const { createFrame, createPolicySession, createRuntime, manifest } = factories ?? {};
  for (const [name, fn] of Object.entries({ createFrame, createPolicySession, createRuntime })) {
    if (typeof fn !== "function") throw new TypeError(`createGuardWith: ${name} must be a function`);
  }
  if (!manifest || typeof manifest !== "object") throw new TypeError("createGuardWith: manifest is required");

  return async function createGuard(options = {}) {
    const { container, onStatus = null, profile = "default", timeouts = {} } = options;
    // API misuse is an exception, not a result code: nothing was attempted.
    if (!container || typeof container !== "object" || !container.ownerDocument) {
      throw new TypeError("createGuard: container must be a DOM element");
    }
    if (onStatus !== null && typeof onStatus !== "function") throw new TypeError("createGuard: onStatus must be a function");
    if (profile !== "default") {
      throw new TypeError(`createGuard: unknown profile ${JSON.stringify(profile)}; this release ships the built-in "default" profile only`);
    }
    const stage = { ...STARTUP_TIMEOUTS, ...timeouts };

    let disposed = false;
    let generation = 0;
    let runtime = null;
    let runtimeGeneration = -1;
    let eventChain = Promise.resolve();
    let eventsPending = 0;

    function status(kind, detail = {}) {
      if (!onStatus) return;
      try { onStatus({ kind, detail }); } catch { /* a host callback fault is the host's problem, not the guard's */ }
    }

    const frame = createFrame({
      container,
      manifest,
      onEvent: handleEvent,
      onStatus: ({ kind, detail }) => {
        if (kind === "startup-warning") status("startup-warning", detail);
        else if (kind === "refused") status("frame-refused", { detail: bounded(String(detail)) });
      },
    });
    const session = createPolicySession({
      frame,
      classes: manifest.classes,
      onTerminated: (reason) => {
        if (disposed || reason.code === "disposed") return;
        status("session-terminated", { code: bounded(reason.code), stage: bounded(reason.stage), detail: bounded(reason.detail) });
      },
    });

    // ---- startup: frame, channel, Lean authority, port -----------------------
    // Resolve only when everything a render needs exists. Each stage rejects
    // with its own StartupError code (src/startup.js); nothing here ever
    // resolves a guard that could not render.
    function teardown() {
      if (runtime) { try { runtime.dispose(); } catch { /* already gone */ } runtime = null; }
      try { session.dispose(); } catch { /* already gone */ }
      try { frame.destroy(); } catch { /* already gone */ }
    }
    let frameInfo = null;
    try {
      frameInfo = await frame.ready;
      await session.start();
      const bound = await withStageTimeout(frame.whenBound(), {
        code: "channel-handshake-timeout",
        timeoutMs: stage.channelHandshakeMs,
        component: "frame-port",
      });
      if (bound !== true) {
        throw new StartupError("channel-handshake-timeout", {
          component: "frame-port", timeoutMs: stage.channelHandshakeMs, detail: "the frame did not report its policy port as bound",
        });
      }
    } catch (error) {
      teardown();
      throw error;
    }
    // frameInfo carries { styleSheets, trustedTypes } from the frame's
    // bootstrap: a host UI legitimately wants to know Trusted Types is present
    // (it is absent on Firefox) and that the stylesheet applied.
    status("ready", { checker: session.checker, frame: frameInfo });

    // ---- the acceptance path every view takes --------------------------------
    // One string in, one result out. The policy Worker parses, asks Lean and
    // delivers the tree to the frame itself; `rendered` here means the frame
    // acknowledged this exact request and generation.
    async function commitView(view, gen, label) {
      const result = await session.preprocess(view, { generation: gen });
      if (disposed) return { status: "superseded", generation: gen, reason: { code: "disposed" } };
      if (gen !== generation || result.status === "superseded") return { status: "superseded", generation: gen };
      if (result.status === "rendered") {
        status("rendered", { generation: gen, requestId: result.requestId, label, changes: result.diagnostics?.total ?? 0 });
        return { status: "rendered", generation: gen, requestId: result.requestId, diagnostics: result.diagnostics, stats: result.stats };
      }
      const reason = boundedReason(result.reason);
      status("rejected", { generation: gen, requestId: result.requestId, label, reason });
      return { status: "rejected", generation: gen, requestId: result.requestId, reason };
    }

    function stopRuntime(gen, reason) {
      if (!runtime || runtimeGeneration !== gen) return;
      const dying = runtime;
      runtime = null;
      runtimeGeneration = -1;
      try { dying.dispose(); } catch { /* already gone */ }
      status("runtime-stopped", { generation: gen, reason: boundedReason(reason) });
    }

    // A new document: in-flight work for the old one is invalidated, its
    // program stops, and anything still queued settles as superseded.
    function supersede() {
      const previous = generation;
      generation = session.nextGeneration();
      stopRuntime(previous, { code: "replaced" });
      return generation;
    }

    // ---- events: frame -> program -> view -> acceptance path ----------------
    // Sequential per program, bounded in depth, and every failure stops that
    // program: an event that cannot be processed is not retried, and a view
    // the authority refuses ends the session that produced it.
    function handleEvent(event) {
      if (disposed || !runtime || runtime.dead) return;
      const gen = runtimeGeneration;
      if (eventsPending >= GUARD_MAX_PENDING_EVENTS) {
        status("event-dropped", { generation: gen, reason: { code: "event-queue-full", limitValue: GUARD_MAX_PENDING_EVENTS } });
        return;
      }
      eventsPending += 1;
      eventChain = eventChain
        .then(() => processEvent(event, gen))
        .catch(() => {})
        .finally(() => { eventsPending -= 1; });
    }

    async function processEvent(event, gen) {
      if (disposed || gen !== generation || !runtime || runtimeGeneration !== gen) return;
      let view;
      try {
        ({ view } = await runtime.step(event));
      } catch (error) {
        const message = bounded(error && error.message) ?? "step failed";
        if (message === "event queue full") {
          status("event-dropped", { generation: gen, reason: { code: "event-queue-full" } });
          return;
        }
        if (gen === generation) stopRuntime(gen, { code: "step-failed", detail: message });
        return;
      }
      if (gen !== generation) return;
      const result = await commitView(view, gen, "view");
      if (result.status === "rejected") stopRuntime(gen, result.reason);
    }

    // ---- the public object ---------------------------------------------------
    const guard = {
      /**
       * Render one document, replacing whatever is shown.
       *
       * `{ html }` validates and commits the string. `{ program, data? }`
       * initializes QuickJS and commits the program's FIRST VIEW; `html` is
       * not rendered on that path, so a program that fails to initialize
       * yields `rejected`, never a quietly rendered static document.
       *
       * Resolves `{ status: "rendered" }` only after the frame acknowledged
       * this exact request and generation, `{ status: "rejected", reason }`
       * for anything the authority or the runtime refused, or
       * `{ status: "superseded" }` when a newer render, clear or dispose won.
       * Throws for API misuse and for infrastructure that is unavailable (a
       * StartupError from the QuickJS Worker).
       */
      async render(input) {
        if (disposed) throw new Error("guard: disposed");
        if (!input || typeof input !== "object") throw new TypeError("render: expected { html, program?, data? }");
        const { html, program, data } = input;
        const hasProgram = program !== undefined && program !== null;
        if (hasProgram && typeof program !== "string") throw new TypeError("render: program must be a string");
        if (!hasProgram && typeof html !== "string") throw new TypeError("render: html must be a string when no program is supplied");
        const gen = supersede();
        if (!hasProgram) return commitView(html, gen, "document");

        const rt = createRuntime({ onDead: (reason) => onRuntimeDead(gen, reason) });
        let view;
        try {
          ({ view } = await rt.load(program, data));
        } catch (error) {
          try { rt.dispose(); } catch { /* already gone */ }
          if (disposed || gen !== generation) return { status: "superseded", generation: gen };
          // Infrastructure (a refused Worker, a missing directive) is an
          // exception with a stage and a code; a program QuickJS refuses is a
          // result, because that is hostile-input territory.
          if (error && error.name === "StartupError") throw error;
          const reason = { code: "program-rejected", detail: bounded(error && error.message) ?? "program failed" };
          status("rejected", { generation: gen, label: "program", reason });
          return { status: "rejected", generation: gen, reason };
        }
        if (disposed || gen !== generation) {
          try { rt.dispose(); } catch { /* already gone */ }
          return { status: "superseded", generation: gen };
        }
        runtime = rt;
        runtimeGeneration = gen;
        const result = await commitView(view, gen, "view");
        if (result.status !== "rendered") stopRuntime(gen, result.status === "rejected" ? result.reason : { code: "superseded" });
        return result;
      },

      /**
       * Clear the display and stop interaction. The empty document goes
       * through the same acceptance path as any other; there is no side door
       * to the frame's DOM.
       */
      async clear() {
        if (disposed) throw new Error("guard: disposed");
        const gen = supersede();
        const result = await commitView("", gen, "clear");
        if (result.status === "rendered") status("cleared", { generation: gen });
        return result;
      },

      /**
       * Release everything: the program, the policy Worker, the frame and
       * its port. Idempotent. Anything still pending settles as superseded,
       * and a late message cannot render or restart anything.
       */
      dispose() {
        if (disposed) return;
        disposed = true;
        generation = session.nextGeneration();
        teardown();
        status("disposed", {});
      },

      get disposed() { return disposed; },
      get generation() { return generation; },
      /** Bounded identity of the Lean/Wasm authority this guard renders through. */
      get checker() { return session.checker; },
      /** True while an interactive program is running for the current document. */
      get interactive() { return runtime !== null && !runtime.dead; },
    };

    function onRuntimeDead(gen, reason) {
      if (disposed || reason === "disposed") return;
      if (runtime && runtimeGeneration === gen) { runtime = null; runtimeGeneration = -1; }
      status("runtime-stopped", { generation: gen, reason: { code: "runtime-dead", detail: bounded(String(reason)) } });
    }

    return guard;
  };
}
