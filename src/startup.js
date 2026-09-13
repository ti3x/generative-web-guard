// Per-stage startup timeouts and startup error codes.
//
// WHY THIS EXISTS. Three of the ways a host's Content-Security-Policy can stop
// this library are not observable as CSP violations at all:
//
//   * If the host `script-src` omits the frame script hash, the frame's inline
//     script is refused. The violation belongs to the FRAME's document, and
//     the frame's script never runs, so nothing reports it. The host sees only
//     silence. (spike/policy-worker-feasibility.md, N8: no
//     `securitypolicyviolation` event on Chromium 140, Firefox 141 or
//     WebKit 26.)
//   * A static top-level cross-origin `import` in a module Worker entry is
//     checked against `worker-src`, not `script-src`, and fails with an opaque
//     `error` event and no violation report (N3). The build must never emit
//     one; see scripts/build.mjs and scripts/check-cdn.mjs.
//   * A cross-origin Worker URL fails on every engine under every CSP,
//     including no CSP (N2). That is the Worker spec's same-origin fetch mode,
//     not a policy decision.
//
// So one aggregate "startup failed" timeout is not actionable. Every startup
// stage gets its own budget and its own code, and the code carries a hint that
// names the directive or the artifact the host has to fix. Where the evidence
// does not support a precise cause -- the frame bootstrap is the case -- the
// hint says what to check and explicitly does not claim a cause.
//
// Nothing here loosens a policy or enables evaluation; these are diagnostics.

/** The stages a session goes through before it can render anything. */
export const STARTUP_STAGES = Object.freeze({
  /** `new Worker(blobUrl)` for the policy Worker or the QuickJS Worker. */
  workerCreate: "worker-create",
  /** The Worker's first `ready`/reply: the host <-> Worker handshake. */
  channelHandshake: "channel-handshake",
  /** QuickJS (or a checker) compiling Wasm inside the Worker. */
  wasmInit: "wasm-init",
  /** The srcdoc frame's inline script running and posting `ready`. */
  frameBootstrap: "frame-bootstrap",
});

/**
 * Per-stage budgets. Deliberately separate numbers: a cold Wasm compile is
 * legitimately slow, while a frame that has not bootstrapped in five seconds
 * is not going to.
 */
export const STARTUP_TIMEOUTS = Object.freeze({
  workerCreateMs: 2_000,
  channelHandshakeMs: 5_000,
  wasmInitMs: 15_000,
  frameBootstrapMs: 5_000,
});

/**
 * Startup error codes. Each one was produced by an actual failing
 * configuration in the browser spike; the table in
 * spike/policy-worker-feasibility.md ("Startup errors that must be surfaced")
 * is the source. `hint` is written for the person who has to change a header.
 */
export const STARTUP_ERRORS = Object.freeze({
  "worker-blob-unsupported": {
    stage: STARTUP_STAGES.workerCreate,
    hint: "This environment has no Worker, Blob or URL.createObjectURL. The library cannot run without them; there is no same-origin-script fallback that is equivalent.",
  },
  "csp-worker-blob": {
    stage: STARTUP_STAGES.workerCreate,
    hint: "The host policy refused a blob: Worker. Add blob: to whichever directive applies -- worker-src, else child-src, else default-src. Recommended: \"worker-src 'self' blob:\". Omitting worker-src does NOT make blob: Workers free: the CSP3 fallback chain then uses child-src and finally default-src, and the applicable directive must contain blob:.",
  },
  "worker-create-timeout": {
    stage: STARTUP_STAGES.workerCreate,
    hint: "The Worker was constructed but produced neither a message nor an error. If a build ever emits a static top-level cross-origin import in a Worker entry, this is exactly what it looks like: worker-src (not script-src) refuses it and no violation is reported. Rebuild and check scripts/check-cdn.mjs.",
  },
  "channel-handshake-timeout": {
    stage: STARTUP_STAGES.channelHandshake,
    hint: "The Worker never completed the protocol handshake. Its top-level script is not CSP-gated by its own policy, so this is a payload or protocol-version problem rather than a directive to relax.",
  },
  "worker-startup-error": {
    stage: STARTUP_STAGES.channelHandshake,
    hint: "The Worker fired an error event during startup with no usable message. This is what a blob: Worker refused by the host policy looks like: check that the applicable worker source directive -- worker-src, else child-src, else default-src -- contains blob:. Chromium also reports a securitypolicyviolation with effectiveDirective worker-src and blockedURI blob in this case; Firefox and WebKit give only the opaque error event.",
  },
  "wasm-init-timeout": {
    stage: STARTUP_STAGES.wasmInit,
    hint: "Wasm instantiation inside the Worker did not finish in its budget. A cold compile is slow but bounded; a stalled one is not a CSP problem.",
  },
  "csp-wasm-unsafe-eval": {
    stage: STARTUP_STAGES.wasmInit,
    hint: "Wasm compilation was refused. A blob: Worker inherits the host document's policy, so add 'wasm-unsafe-eval' to the host script-src. Do NOT use 'unsafe-eval': 'wasm-unsafe-eval' alone leaves eval and new Function blocked, which was confirmed on all three engines.",
  },
  "checker-init-failed": {
    stage: STARTUP_STAGES.wasmInit,
    hint: "The policy Worker could not start its Lean/Wasm acceptance checker, so this session cannot accept any document. There is no fallback to the JavaScript checker: that would bypass the acceptance authority, so the library refuses to render instead. The accompanying detail is the checker's own bounded reason -- an ABI or checker-version mismatch means the bundle and the module came from different builds; a CompileError means the host script-src is missing 'wasm-unsafe-eval'.",
  },
  "csp-connect-src": {
    stage: STARTUP_STAGES.wasmInit,
    hint: "A runtime asset fetch was refused. Allow the origin serving it in connect-src. The bundled QuickJS variant embeds its binary and needs no connect-src; a separately shipped .wasm does.",
  },
  "csp-cdn-script-src": {
    stage: STARTUP_STAGES.workerCreate,
    hint: "A cross-origin module import was refused (effectiveDirective script-src-elem). Add the library origin to the host script-src UNLESS the policy contains 'strict-dynamic', in which case host-source and 'self' expressions are ignored entirely and adding the origin does nothing: the fix is then a nonce attribute on the tag that loads the library, matching the policy's 'nonce-...' value. Firefox says so in the console (Ignoring \"'self'\" within script-src: 'strict-dynamic' specified). See docs/csp.md, Profile C. Inside a Worker use await import(): a dynamic import is checked against script-src, a static top-level import against worker-src.",
  },
  "frame-bootstrap-timeout": {
    stage: STARTUP_STAGES.frameBootstrap,
    // N8: no violation report exists for this case, so the message must not
    // assert a cause. It lists what to check instead.
    hint: "The sandboxed frame never reported ready. A CSP failure inside a srcdoc frame produces NO securitypolicyviolation event on any engine, so the cause cannot be determined from here. Check that the host policy's script-src contains the frame script hash and that style-src contains the frame style hash, both exactly as built. A NONCE-BASED HOST POLICY is the configuration most often reported for this timeout, and it cannot be confirmed from here either: 'strict-dynamic' does NOT disable hashes -- the frame hash is still required and still works -- while 'unsafe-inline' is IGNORED whenever a nonce or a hash is present, so a nonce policy that carries 'unsafe-inline' but no frame hash produces exactly this timeout on Chromium 140, Firefox 141 and WebKit 26. See docs/csp.md, Profile C.",
  },
});

/** Non-fatal startup conditions. These warn; they never fail startup. */
export const STARTUP_WARNINGS = Object.freeze({
  "frame-style-hash-missing": "The frame rendered but its stylesheet hash is not in the host style-src. The frame works unstyled; the frame-side violation is not visible to the host. Add 'sha256-<cssHash>' to style-src.",
});

/**
 * A startup failure. Distinct from ordinary rejections: those are hostile-input
 * result codes, this is "the platform or the host configuration will not let
 * this session exist".
 */
export class StartupError extends Error {
  constructor(code, extra = {}) {
    const entry = STARTUP_ERRORS[code];
    const stage = extra.stage ?? entry?.stage ?? "unknown";
    const hint = extra.hint ?? entry?.hint ?? "";
    super(`${code} (stage: ${stage})${hint ? ": " + hint : ""}${extra.detail ? " -- " + extra.detail : ""}`);
    this.name = "StartupError";
    this.code = code;
    this.stage = stage;
    this.hint = hint;
    if (extra.detail !== undefined) this.detail = String(extra.detail).slice(0, 300);
    if (extra.timeoutMs !== undefined) this.timeoutMs = extra.timeoutMs;
    if (extra.component !== undefined) this.component = extra.component;
  }
  /** Bounded plain data for a status callback or a test assertion. */
  toJSON() {
    return {
      code: this.code,
      stage: this.stage,
      hint: this.hint,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.component !== undefined ? { component: this.component } : {}),
    };
  }
}

/**
 * Map a caught error, or a bounded error string relayed out of a Worker, onto
 * a startup code. Only patterns the spike actually observed are matched.
 *
 * Deliberately narrow. The QuickJS `load` round trip both instantiates Wasm
 * and compiles the generated program, so a guest program that simply does not
 * compile arrives here too -- and that is an ordinary content rejection, not a
 * startup failure. Pass `null` as `fallbackCode` to get `null` back when
 * nothing matched, and keep the original error in that case.
 */
export function classifyStartupFailure(stage, error, fallbackCode) {
  const text = error == null
    ? ""
    : typeof error === "string"
      ? error
      : `${error.name ?? ""} ${error.message ?? ""}`;
  // Chromium: "CompileError: WebAssembly.Module(): Refused to compile or
  // instantiate WebAssembly module because 'unsafe-eval' is not an allowed
  // source of script ...". Firefox reports a CompileError too. Both report
  // effectiveDirective script-src / blockedURI wasm-eval. Matching bare
  // "WebAssembly" would misread a guest error mentioning it, so do not.
  if (/CompileError|wasm-eval|wasm-unsafe-eval|Refused to compile or instantiate|blocked by CSP/i.test(text)) {
    return "csp-wasm-unsafe-eval";
  }
  // worker-src / child-src / default-src without blob:.
  if (/blob/i.test(text) && /(refus|block|violat|security|content security)/i.test(text)) return "csp-worker-blob";
  // Chromium throws this synchronously for a cross-origin Worker URL.
  if (/cannot be accessed from origin|SecurityError/i.test(text)) return "csp-worker-blob";
  // WebKit 26 reports a refused dynamic import as
  // "TypeError: Importing a module script failed." with no directive in it, so
  // it matches nothing else here and would fall through to a generic code.
  // Measured in spike/nonce/ on Chromium 140.0.7339.186, Firefox 141.0 and
  // WebKit 26.0.
  if (/dynamically imported module|script-src-elem|Importing a module script failed/i.test(text)) return "csp-cdn-script-src";
  if (/compileStreaming|connect-src/i.test(text)) return "csp-connect-src";
  return fallbackCode === undefined ? "worker-startup-error" : fallbackCode;
}

/**
 * Race one startup stage against its own budget. On timeout the stage's code
 * is raised and `onTimeout` runs, so the caller can terminate whatever did not
 * come up instead of leaving it running.
 */
export function withStageTimeout(promise, { code, timeoutMs, component, onTimeout }) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) { try { onTimeout(); } catch { /* best effort */ } }
      reject(new StartupError(code, { timeoutMs, component }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Create a Worker from a self-contained source string via a blob: URL.
 *
 * This is the only Worker creation path the library offers, and it is
 * deliberate. `new Worker("https://cdn/...")` fails on Chromium, Firefox and
 * WebKit under EVERY CSP including no CSP, because the Worker constructor
 * fetches a dedicated worker's script in same-origin mode. A cross-origin
 * Worker URL is not a configuration problem; it can never work. A blob: Worker
 * also INHERITS the creating document's CSP, which a same-origin network
 * Worker does not -- see docs/csp.md, Profile B.
 *
 * `source` must be the complete payload. It must not contain a static
 * top-level import of anything cross-origin; the build asserts that.
 */
export function createBlobWorker(source, options = {}) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("createBlobWorker: a non-empty source string is required");
  }
  if (typeof Worker === "undefined" || typeof Blob === "undefined"
      || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new StartupError("worker-blob-unsupported");
  }
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const worker = new Worker(url, options);
    // Revoking immediately is safe once the constructor has returned; the
    // fetch is already committed. Doing it in a task keeps Safari happy.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return worker;
  } catch (error) {
    URL.revokeObjectURL(url);
    // A REFUSED blob: WORKER DOES NOT REACH HERE on any engine. Measured in
    // spike/nonce/ on Chromium 140.0.7339.186, Firefox 141.0 and WebKit 26.0,
    // under both a nonce policy and the Profile A shape: `new Worker()`
    // returned normally and an opaque `error` event followed. So all three
    // engines report that case asynchronously and a consumer actually gets
    // `worker-startup-error` at the channel-handshake stage, whose hint names
    // blob:. An earlier comment here claimed Chromium threw synchronously;
    // that was wrong.
    //
    // This catch is still reachable and still wanted: a cross-origin Worker
    // URL throws a SecurityError on Chromium synchronously, and an environment
    // without blob: URL support throws before this point.
    throw new StartupError(classifyStartupFailure(STARTUP_STAGES.workerCreate, error, "csp-worker-blob"), {
      detail: error && error.message ? error.message : String(error),
    });
  }
}
