// Host side of the policy Worker channel.
//
// Owns the Worker lifecycle, the versioned envelope, and the only mechanism
// that can stop parse5 mid-parse: termination. An adapter check cannot
// interrupt the parser, so the request timer lives here, outside the Worker.
//
// Contract:
//   * preprocess() always settles exactly once, with a result code. Expected
//     hostile-input failures are codes, not exceptions; API misuse (disposed
//     session, missing createWorker) throws.
//   * On timeout or worker error the Worker is terminated, the request that
//     timed out settles with { code: "timeout" }, and every other pending
//     request settles with { code: "session-terminated" }. Nothing is left
//     hanging and nothing is retried implicitly.
//   * A terminated session is replaced on the next call by a fresh Worker
//     with a NEW sessionId, so replies from the dead session can never match.
//   * Replies are dropped unless the protocol version, instanceId, sessionId
//     and requestId all match a pending request. Duplicates are dropped
//     because the pending entry is removed when the first reply settles it.
//   * Replies for a superseded generation settle as "superseded" and are
//     never rendered.
//   * An accepted reply must name the Lean authority and carry a well-formed
//     one-time acceptance record minted in the Worker. Anything else settles
//     as a rejection. Records carry diagnostic identity, not a render capability.
//     Attached sessions never receive a tree; the Worker commits over its
//     private port. Headless diagnostic sessions cannot commit their trees.
//   * Every request declares its delivery (src/policy-protocol.js). A session
//     with a frame HOLDS its requests until the Worker confirms it installed
//     the port (policy/frame-attached), so no request can be served before
//     the port exists; the request budget still bounds that wait
//     (`frame-attach-timeout`). An accepted reply that nevertheless carries a
//     tree to a frame session is a protocol violation, not a timing quirk:
//     the request is refused AND the session is terminated.
//   * Startup has a THIRD stage now: wasm-init. `policy/ready` means the
//     payload loaded; `policy/checker-ready` means the Lean authority exists.
//     Until the second one arrives nothing can be accepted, and if
//     `policy/failed` arrives instead, nothing ever will be -- there is no
//     fallback to the JavaScript checker.
//   * Startup has two stages with two budgets and two codes: worker-create
//     (csp-worker-blob / worker-blob-unsupported) and channel-handshake
//     (channel-handshake-timeout / worker-startup-error). whenReady() exposes
//     them. One aggregate startup timeout would not tell a host which header
//     to change, which is the whole reason for the split -- see
//     src/startup.js and docs/csp.md.
//
// This client does not render anything and never executes generated
// JavaScript. It hands the accepted candidate back to its caller.

import {
  POLICY_MESSAGE,
  POLICY_PROTOCOL_VERSION,
  POLICY_TIMEOUTS,
  POLICY_DELIVERY,
  isPolicyEnvelope,
} from "./policy-protocol.js";
import { LEAN_AUTHORITY, LEAN_CHECKER_VERSION } from "./lean-abi.js";
import { isAcceptanceToken } from "./acceptance.js";
import { PREVIEW_MAX_CHARS } from "./preview.js";
import {
  STARTUP_ERRORS,
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  StartupError,
  classifyStartupFailure,
} from "./startup.js";

let counter = 0;
function newId(prefix) {
  counter += 1;
  const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${counter}-${random}`;
}

export function createPolicySession(options = {}) {
  // `frame` is the sandbox frame API (src/host.js): when given, every new
  // Worker session gets a fresh MessageChannel whose ends go to the Worker and
  // the frame, and accepted trees stop coming back to this host at all.
  const { createWorker, classes = null, onTerminated = null, frame = null } = options;
  if (typeof createWorker !== "function") {
    throw new TypeError("createPolicySession: createWorker is required");
  }
  // Request budgets and startup-stage budgets in one place. They are separate
  // numbers on purpose: see src/startup.js.
  const timeouts = { ...POLICY_TIMEOUTS, ...STARTUP_TIMEOUTS, ...(options.timeouts || {}) };
  const instanceId = options.instanceId ?? newId("policy");

  let sessionId = null;
  let worker = null;
  let generation = 0;
  let nextRequestId = 1;
  let disposed = false;
  let classAllowlistSent = false;
  let checkerIdentity = null;
  let frameAttached = false; // the Worker confirmed it holds the frame port
  const pending = new Map(); // requestId -> { resolve, timer, generation, budget, posted }
  // Envelopes built for a frame session before the Worker confirmed the port.
  // Posted in order on policy/frame-attached; settled by terminate() otherwise.
  const awaitingAttach = [];
  const stats = { requests: 0, accepted: 0, rendered: 0, rejected: 0, timeouts: 0, sessions: 0 };

  // ---- wasm-init stage --------------------------------------------------
  let checkerReadyPromise = null;
  let checkerReadySettled = false;
  let settleChecker = null;
  let failChecker = null;

  function newCheckerPromise() {
    checkerReadySettled = false;
    checkerReadyPromise = new Promise((resolve, reject) => {
      settleChecker = (value) => { checkerReadySettled = true; resolve(value); };
      failChecker = (error) => { checkerReadySettled = true; reject(error); };
    });
    checkerReadyPromise.catch(() => {});
  }

  // ---- startup stages ---------------------------------------------------
  // Two separate stages with separate budgets and separate codes, because the
  // two failures need different fixes:
  //   worker-create      -> Worker construction itself failed. A cross-origin
  //                         Worker URL throws a SecurityError here on
  //                         Chromium, and a platform with no blob: URL support
  //                         fails here too. A blob: Worker REFUSED BY THE HOST
  //                         POLICY does NOT land here on any engine: measured
  //                         in spike/nonce/ on Chromium 140, Firefox 141 and
  //                         WebKit 26, all three returned from `new Worker()`
  //                         normally and fired an opaque error event, which
  //                         the channel-handshake stage catches.
  //   channel-handshake  -> the Worker exists but never answered. Its own top
  //                         level script is never CSP-gated, so this is not a
  //                         directive to relax.
  // Collapsing them into one "startup failed" timeout is what makes a CSP
  // misconfiguration un-actionable, so they stay apart.
  let handshakeTimer = null;
  let handshakeDone = false;
  // The wasm-init stage has its own timer. Without it, a Worker that loads but
  // never finishes instantiating its checker would leave whenCheckerReady()
  // pending forever for a caller that never sends a request.
  let checkerTimer = null;
  // The most recent startup attempt, settled or not. It is REPLACED when a
  // new session starts and never discarded on failure, so whenReady() can
  // still report the code of a startup that already failed.
  let readyPromise = null;
  let readySettled = false;
  let settleReady = null;
  let failReady = null;

  function newReadyPromise() {
    readySettled = false;
    readyPromise = new Promise((resolve, reject) => {
      settleReady = (value) => { readySettled = true; resolve(value); };
      failReady = (error) => { readySettled = true; reject(error); };
    });
    readyPromise.catch(() => {}); // nobody has to await it
  }

  function start() {
    sessionId = newId("session");
    handshakeDone = false;
    checkerIdentity = null;
    // A new session has a new checker instance, so no acceptance from the old
    // one may settle against it.
    // Reuse a promise a caller is already waiting on; replace a settled one.
    if (readyPromise === null || readySettled) newReadyPromise();
    if (checkerReadyPromise === null || checkerReadySettled) newCheckerPromise();
    try {
      worker = createWorker();
    } catch (error) {
      worker = null;
      sessionId = null;
      const startupError = error instanceof StartupError
        ? error
        : new StartupError(
          classifyStartupFailure(STARTUP_STAGES.workerCreate, error, "csp-worker-blob"),
          { component: "policy-worker", detail: error && error.message ? error.message : String(error) },
        );
      failReady(startupError);
      throw startupError;
    }
    classAllowlistSent = false;
    stats.sessions += 1;
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onWorkerError);
    // The Worker exists; now it has its own budget to complete the handshake.
    handshakeTimer = setTimeout(() => {
      if (handshakeDone) return;
      terminate({ code: "channel-handshake-timeout", detail: `no policy/ready within ${timeouts.channelHandshakeMs}ms`, stage: STARTUP_STAGES.channelHandshake });
    }, timeouts.channelHandshakeMs);
    checkerTimer = setTimeout(() => {
      if (checkerIdentity !== null) return;
      terminate({
        code: "wasm-init-timeout",
        detail: `no policy/checker-ready within ${timeouts.wasmInitMs}ms; the Lean/Wasm authority never became available, so this session cannot accept a document`,
        stage: STARTUP_STAGES.wasmInit,
      });
    }, timeouts.wasmInitMs);
    return worker;
  }

  function settle(entry, requestId, body) {
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ requestId, generation: entry.generation, ...body });
  }

  // Wire a fresh private channel: one end to the Worker (transferred), the
  // other to the frame's bootstrap. Called on every channel handshake, so a
  // replaced Worker gets a replaced port and the old one dies with it.
  function attachFrameToWorker() {
    try {
      const channel = new MessageChannel();
      worker.postMessage({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.attachFrame, instanceId, sessionId }, [channel.port1]);
      const bound = frame.attachPort(channel.port2, { instanceId, sessionId });
      if (bound && typeof bound.catch === "function") bound.catch(() => {});
    } catch (error) {
      terminate({ code: "frame-attach-failed", detail: String(error && error.message).slice(0, 200) });
    }
  }

  // Terminate the Worker and settle every pending request once.
  function terminate(reason, timedOutRequestId = null) {
    const dying = worker;
    const dyingSession = sessionId;
    worker = null;
    sessionId = null;
    frameAttached = false;
    awaitingAttach.length = 0; // their pending entries settle below
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    clearTimeout(checkerTimer);
    checkerTimer = null;
    // A session that died before its handshake never became usable: fail the
    // startup promise with the stage's own code instead of leaving it pending.
    if (!handshakeDone && failReady && !readySettled) {
      if (reason.code === "disposed") {
        failReady(new Error("policy session disposed before startup completed"));
      } else {
        failReady(new StartupError(
          reason.code === "channel-handshake-timeout"
            ? "channel-handshake-timeout"
            : classifyStartupFailure(STARTUP_STAGES.channelHandshake, reason.detail, "worker-startup-error"),
          { component: "policy-worker", detail: reason.detail, timeoutMs: timeouts.channelHandshakeMs },
        ));
      }
    }
    // A session that died before its checker existed can never accept
    // anything. Fail that stage rather than leaving a caller waiting for a
    // checker that is not coming.
    if (failChecker && !checkerReadySettled) {
      failChecker(reason.code === "disposed"
        ? new Error("policy session disposed before the checker was ready")
        : new StartupError(reason.code in STARTUP_ERRORS ? reason.code : "wasm-init-timeout", {
          component: "policy-worker", detail: reason.detail, timeoutMs: timeouts.wasmInitMs,
        }));
    }
    if (dying) {
      dying.removeEventListener("message", onMessage);
      dying.removeEventListener("error", onWorkerError);
      try { dying.terminate(); } catch { /* already gone */ }
    }
    for (const [requestId, entry] of [...pending.entries()]) {
      const body = requestId === timedOutRequestId
        ? { status: "rejected", reason: { code: reason.code, limit: "requestMs", limitValue: entry.budget } }
        : { status: "rejected", reason: { code: "session-terminated", detail: reason.code } };
      settle(entry, requestId, body);
    }
    if (onTerminated) { try { onTerminated({ ...reason, sessionId: dyingSession }); } catch { /* host callback */ } }
  }

  function onWorkerError(event) {
    const detail = event && typeof event.message === "string" ? event.message.slice(0, 200) : "worker error";
    // Before the handshake this is a startup failure, and on Firefox and
    // WebKit the event carries no message at all -- an opaque error event is
    // exactly what a refused blob: Worker looks like there. Say so rather than
    // reporting a bare "worker error".
    if (!handshakeDone) {
      return terminate({
        code: "worker-startup-error",
        stage: STARTUP_STAGES.workerCreate,
        detail: detail === "worker error"
          ? "opaque Worker error event during startup (Firefox/WebKit report no message); check that the host policy's worker source directive contains blob:"
          : detail,
      });
    }
    terminate({ code: "worker-error", detail });
  }

  function onMessage(event) {
    if (disposed || worker === null) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.protocol !== POLICY_PROTOCOL_VERSION) return;
    if (message.kind === POLICY_MESSAGE.ready) {
      if (handshakeDone) return; // duplicate ready must not replace a live port
      // channel-handshake stage complete.
      handshakeDone = true;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      if (settleReady) settleReady({ sessionId, protocol: message.protocol });
      if (frame) attachFrameToWorker();
      return;
    }
    if (message.kind === POLICY_MESSAGE.frameAttached) {
      if (message.instanceId !== instanceId || message.sessionId !== sessionId) return;
      frameAttached = true;
      // The Worker holds the port: release the requests held for it, in order.
      while (awaitingAttach.length > 0 && worker !== null) postEnvelope(awaitingAttach.shift());
      return;
    }
    if (message.kind === POLICY_MESSAGE.checkerReady) {
      // wasm-init stage complete. The identity is bounded plain data; the
      // Worker already refused to start unless it matched this build.
      const checker = message.checker;
      if (!checker || typeof checker !== "object" || checker.checkerVersion !== LEAN_CHECKER_VERSION) {
        return terminate({
          code: "checker-identity-mismatch",
          stage: STARTUP_STAGES.wasmInit,
          detail: `worker reported ${JSON.stringify(checker?.checkerVersion)}, this build expects ${LEAN_CHECKER_VERSION}`,
        });
      }
      checkerIdentity = checker;
      clearTimeout(checkerTimer);
      checkerTimer = null;
      if (settleChecker) settleChecker(checker);
      return;
    }
    if (message.kind === POLICY_MESSAGE.failed) {
      // The authority could not start. No fallback exists; kill the session so
      // every pending and future request refuses with a reason.
      // The Worker reports `checker-init-failed` with a bounded detail; the
      // classification happens HERE so the Worker payload does not have to
      // carry the diagnostics module. A CompileError in that detail means the
      // host script-src is missing 'wasm-unsafe-eval', which is a header to
      // change rather than a build to investigate.
      const reported = message.reason?.code;
      const detail = String(message.reason?.detail ?? "the policy worker could not start its checker").slice(0, 300);
      const fallback = typeof reported === "string" && reported in STARTUP_ERRORS ? reported : "worker-startup-error";
      return terminate({
        code: classifyStartupFailure(STARTUP_STAGES.wasmInit, detail, fallback),
        stage: STARTUP_STAGES.wasmInit,
        detail,
      });
    }
    if (!isPolicyEnvelope(message, { instanceId, sessionId })) return; // stale/foreign
    const entry = pending.get(message.requestId);
    if (!entry) return; // unexpected or duplicate: already settled
    if (message.generation !== entry.generation) {
      return settle(entry, message.requestId, { status: "rejected", reason: { code: "generation-mismatch" } });
    }
    if (message.kind === POLICY_MESSAGE.refused) {
      stats.rejected += 1;
      return settle(entry, message.requestId, { status: "rejected", reason: message.reason ?? { code: "refused" } });
    }
    if (message.kind !== POLICY_MESSAGE.result) return;
    if (message.status === "rejected" && message.reason?.code === "checker-poisoned") {
      stats.rejected += 1;
      settle(entry, message.requestId, { status: "rejected", reason: message.reason });
      return terminate({ code: "checker-poisoned", detail: "the Lean instance is unusable" });
    }
    if (entry.generation !== generation) {
      return settle(entry, message.requestId, { status: "superseded" });
    }
    if (message.status === "rendered") {
      // The frame acknowledged this exact request over the private port; the
      // Worker delivered Lean's tree itself and this reply carries none. The
      // same identity and authority checks apply as to an accepted reply.
      if (message.authority !== LEAN_AUTHORITY) {
        stats.rejected += 1;
        return settle(entry, message.requestId, {
          status: "rejected",
          reason: { code: "authority-not-lean", detail: String(message.authority).slice(0, 60) },
        });
      }
      const token = message.acceptance;
      if (!isAcceptanceToken(token) || token.instanceId !== instanceId || token.sessionId !== sessionId
          || token.requestId !== message.requestId || token.generation !== message.generation
          || token.checkerVersion !== LEAN_CHECKER_VERSION) {
        stats.rejected += 1;
        return settle(entry, message.requestId, { status: "rejected", reason: { code: "acceptance-identity-mismatch" } });
      }
      if ("tree" in message) {
        stats.rejected += 1;
        return settle(entry, message.requestId, { status: "rejected", reason: { code: "rendered-with-tree" } });
      }
      stats.accepted += 1;
      stats.rendered += 1;
      return settle(entry, message.requestId, {
        status: "rendered",
        authority: message.authority,
        acceptance: token,
        diagnostics: message.diagnostics,
        ...(typeof message.preview === "string" ? { preview: message.preview.slice(0, PREVIEW_MAX_CHARS) } : {}),
        stats: message.stats,
      });
    }
    if (message.status === "accepted" && frame) {
      // A frame session's requests are held until the Worker confirmed the
      // port and declare `delivery: "frame"`, which the Worker refuses to
      // serve without a port. So a tree arriving here did not race anything:
      // the Worker violated the protocol. Refuse the request and end the
      // session, the same way an identity mismatch is handled.
      stats.rejected += 1;
      settle(entry, message.requestId, { status: "rejected", reason: { code: "authority-path-mismatch" } });
      return terminate({ code: "authority-path-mismatch", detail: "an accepted reply carried a tree to a frame session" });
    }
    if (message.status === "accepted") {
      // An accepted reply has to name the Lean authority and carry a
      // well-formed one-time record minted next to that verdict. A reply that
      // merely says "accepted" -- a spoofed or replayed message, or a Worker
      // built from other sources -- settles as a rejection and renders nothing.
      if (message.authority !== LEAN_AUTHORITY) {
        stats.rejected += 1;
        return settle(entry, message.requestId, {
          status: "rejected",
          reason: { code: "authority-not-lean", detail: String(message.authority).slice(0, 60) },
        });
      }
      if (!isAcceptanceToken(message.acceptance)) {
        stats.rejected += 1;
        return settle(entry, message.requestId, { status: "rejected", reason: { code: "acceptance-malformed" } });
      }
      const token = message.acceptance;
      if (token.instanceId !== instanceId || token.sessionId !== sessionId
          || token.requestId !== message.requestId || token.generation !== message.generation) {
        stats.rejected += 1;
        return settle(entry, message.requestId, { status: "rejected", reason: { code: "acceptance-identity-mismatch" } });
      }
      if (token.checkerVersion !== LEAN_CHECKER_VERSION) {
        stats.rejected += 1;
        return settle(entry, message.requestId, {
          status: "rejected",
          reason: { code: "acceptance-checker-version", detail: String(token.checkerVersion).slice(0, 60) },
        });
      }
      stats.accepted += 1;
      return settle(entry, message.requestId, {
        status: "accepted",
        authority: message.authority,
        // Headless diagnostic result only: there is no API to commit this tree.
        acceptance: token,
        tree: message.tree,
        diagnostics: message.diagnostics,
        ...(typeof message.preview === "string" ? { preview: message.preview.slice(0, PREVIEW_MAX_CHARS) } : {}),
        stats: message.stats,
      });
    }
    if (message.status === "rejected") {
      stats.rejected += 1;
      return settle(entry, message.requestId, { status: "rejected", reason: message.reason ?? { code: "rejected" } });
    }
    stats.rejected += 1;
    settle(entry, message.requestId, { status: "rejected", reason: { code: "malformed-reply" } });
  }

  /**
   * Send one bounded HTML string for preprocessing, candidate construction and
   * (from Phase 4) Lean acceptance. Always settles.
   */
  function preprocess(html, requestOptions = {}) {
    if (disposed) throw new Error("policy session disposed");
    const fresh = worker === null;
    if (fresh) {
      try {
        start();
      } catch (error) {
        // Worker creation itself failed -- a cross-origin Worker URL
        // (SecurityError on Chromium) or a platform without blob: URLs.
        // Settle with the startup code rather than throwing, so a caller's
        // single result path still sees exactly what to fix.
        const reason = error instanceof StartupError
          ? error.toJSON()
          : { code: "worker-create-failed", detail: String(error && error.message).slice(0, 200) };
        stats.requests += 1;
        stats.rejected += 1;
        return Promise.resolve({ requestId: nextRequestId++, generation, status: "rejected", reason });
      }
    }
    const requestId = nextRequestId++;
    const budget = requestOptions.timeoutMs ?? (fresh ? timeouts.startupMs : timeouts.requestMs);
    const requestGeneration = requestOptions.generation ?? generation;
    stats.requests += 1;

    return new Promise((resolve) => {
      const entry = { resolve, generation: requestGeneration, budget, posted: false, timer: null };
      entry.timer = setTimeout(() => {
        stats.timeouts += 1;
        // Only termination can interrupt the parser; do it, then settle. A
        // request still held for the port names that wait, not the parser.
        const reason = entry.posted
          ? { code: "timeout", detail: `request ${requestId} exceeded ${budget}ms` }
          : { code: "frame-attach-timeout", detail: `the Worker did not confirm the frame port within ${budget}ms` };
        terminate(reason, requestId);
      }, budget);
      pending.set(requestId, entry);
      const envelope = {
        protocol: POLICY_PROTOCOL_VERSION,
        kind: POLICY_MESSAGE.preprocess,
        instanceId,
        sessionId,
        generation: requestGeneration,
        requestId,
        // Declared, never inferred: the Worker refuses a mismatch with its
        // actual port state (src/policy-protocol.js#deliveryRefusal).
        delivery: frame ? POLICY_DELIVERY.frame : POLICY_DELIVERY.host,
        html,
        ...(requestOptions.preview === true ? { preview: true } : {}),
      };
      // The class allowlist is trusted host build configuration; send it once
      // per session rather than with every document.
      if (!classAllowlistSent && Array.isArray(classes)) {
        envelope.classes = classes;
        classAllowlistSent = true;
      }
      // A frame session posts nothing until the Worker confirmed the port.
      if (frame && !frameAttached) awaitingAttach.push(envelope);
      else postEnvelope(envelope);
    });
  }

  function postEnvelope(envelope) {
    const entry = pending.get(envelope.requestId);
    if (!entry) return; // settled while held (terminated or disposed)
    entry.posted = true;
    try {
      worker.postMessage(envelope);
    } catch (error) {
      const detail = error && typeof error.message === "string" ? error.message.slice(0, 200) : "postMessage failed";
      terminate({ code: "post-failed", detail });
    }
  }

  return {
    preprocess,
    /**
     * The channel-handshake stage as a promise. Resolves once the Worker has
     * sent policy/ready; rejects with a StartupError whose code is
     * `csp-worker-blob`, `worker-startup-error` or
     * `channel-handshake-timeout`. Pre-caught, so ignoring it is safe.
     * Returns null once a session has already completed its handshake and
     * been replaced, since there is then no startup in progress.
     */
    whenReady() {
      // Callable before the first request: the Worker is created lazily, so
      // this waits for the first session's two startup stages rather than
      // failing for not having started yet.
      if (readyPromise === null) newReadyPromise();
      return readyPromise;
    },
    /**
     * Start the session eagerly and resolve when the Lean/Wasm authority is
     * ready. Idempotent.
     *
     * The Worker is created lazily on the first request, which means
     * `whenReady()` and `whenCheckerReady()` do not settle until something
     * actually asks for a document. Call this when startup failures should
     * surface BEFORE the first render -- which is what the integrated API in
     * Phase 5 needs, and what a host wants if it is going to show a startup
     * error instead of a rejected document.
     *
     * Rejects with a StartupError. It never falls back to a session without an
     * authority: a rejected start means this session cannot render.
     */
    start() {
      if (disposed) throw new Error("policy session disposed");
      // Keep the settled promise while its Worker is alive. Only the internal
      // start() of a replacement Worker may reset a completed startup stage.
      if (checkerReadyPromise === null) newCheckerPromise();
      if (worker === null) {
        try {
          start();
        } catch (error) {
          // start() already failed the startup promises with a StartupError.
          return Promise.reject(error);
        }
      }
      return checkerReadyPromise;
    },

    /**
     * The wasm-init stage as a promise. Resolves with the checker identity
     * once the Worker's Lean/Wasm authority exists, or rejects with a
     * StartupError (`checker-init-failed`, `csp-wasm-unsafe-eval`,
     * `wasm-init-timeout`). Pre-caught, so ignoring it is safe.
     *
     * A caller that wants to know "can this session render at all" must await
     * THIS, not `whenReady()`: the channel handshake completes before the
     * checker exists.
     */
    whenCheckerReady() {
      if (checkerReadyPromise === null) newCheckerPromise();
      return checkerReadyPromise;
    },

    /** Bounded identity of the authority in the live Worker, or null. */
    get checker() { return checkerIdentity; },

    /** Invalidate in-flight work for the previous document. */
    nextGeneration() {
      generation += 1;
      // Replies for earlier generations cannot settle current work.
      return generation;
    },
    /** Idempotent: settles everything pending and releases the Worker. */
    dispose() {
      if (disposed) return;
      disposed = true;
      terminate({ code: "disposed" });
    },
    /** True once the live Worker confirmed it holds the frame's port. Until
     * then a frame session holds its requests; see `awaitingCount`. */
    get frameAttached() { return frameAttached; },
    /** Requests built but not yet posted because the port is unconfirmed. */
    get awaitingCount() { return awaitingAttach.length; },
    get instanceId() { return instanceId; },
    get sessionId() { return sessionId; },
    get generation() { return generation; },
    get pendingCount() { return pending.size; },
    get stats() { return { ...stats }; },
    get alive() { return worker !== null; },
  };
}
