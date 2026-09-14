// Production glue for the Lean/Wasm checker.
//
// This is the component that makes the proved checker the acceptance
// authority. It owns exactly one WebAssembly instance, speaks only the
// versioned single-document ABI (src/lean-abi.js), and has one job: turn a
// bounded candidate tree into Lean's verdict, or into a refusal.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
// There is no fallback. A missing module, a failed instantiation, a version or
// limits mismatch, a rejection, a malformed response, a trap and a timeout all
// produce a refusal. None of them produces an acceptance, and none of them
// hands the caller a tree. A fallback to the JavaScript checker would be a
// bypass of the authority, not a degraded mode.
//
// POISONING
//
// A WebAssembly trap -- a call-stack overflow inside the module is the
// realistic one, see the maxRawNodes note in src/policy-protocol.js -- leaves
// the instance's memory and the shim's in-call flag in an undefined state. The
// instance is therefore POISONED permanently: every later call refuses with
// `lean-checker-poisoned`. Resetting and continuing would mean answering from
// a module whose invariants may no longer hold. The policy Worker reports the
// refusal, the host's request budget terminates the Worker, and the next
// request gets a new Worker with a new instance.
//
// WHAT THIS MODULE DOES NOT CLAIM
//
// It is trusted glue. The Lean theorems are about `acceptCandidate`; they say
// nothing about this file, the Emscripten runtime, the C shim, the browser or
// the JSON codec on either side. What it does provide is that every tree it
// returns came out of a `guard_check_document` response that validated against
// the ABI, with the checker identity and limits the build expects.

import {
  LEAN_ABI_LIMITS,
  checkRequest,
  configureRequest,
  readCheckResponse,
  readInfoResponse,
  shimCode,
} from "./lean-abi.js";


const encoder = new TextEncoder();
// `fatal` matters: a response that is not valid UTF-8 must be an error, not a
// string full of replacement characters that then parses as something else.
const decoder = new TextDecoder("utf-8", { fatal: true });

function refusal(code, detail) {
  return detail === undefined
    ? { status: "error", reason: { code } }
    : { status: "error", reason: { code, detail: String(detail).slice(0, 200) } };
}

/**
 * Create and configure one checker instance.
 *
 * @param {object} options
 * @param {(config:object)=>Promise<object>} options.createModule
 *        The Emscripten factory (`lean/wasm/dist/guard.mjs`'s default export).
 * @param {Uint8Array} options.wasmBinary
 *        The checker bytes. Passed as `wasmBinary` so the module never fetches
 *        anything: the host CSP keeps `connect-src 'none'` and the bytes that
 *        run are the bytes in the bundle.
 * @param {string[]} options.classes        trusted build class allowlist
 * @param {string} options.stylesheetHash   trusted build stylesheet identity
 * @returns {Promise<object>} the checker
 * @throws  on any startup failure. Callers must treat a throw as "this session
 *          cannot render", never as "carry on without Lean".
 */
export async function createLeanChecker({ createModule, wasmBinary, classes, stylesheetHash }) {
  if (typeof createModule !== "function") {
    throw new TypeError("createLeanChecker: createModule is required");
  }
  if (!(wasmBinary instanceof Uint8Array) || wasmBinary.byteLength === 0) {
    throw new TypeError("createLeanChecker: wasmBinary must be a non-empty Uint8Array");
  }

  const Module = await createModule({ wasmBinary });
  const bind = (name, ret, args) => Module.cwrap(name, ret, args);
  let api;
  try {
    api = {
      init: bind("guard_init", "number", []),
      info: bind("guard_info", "number", []),
      configure: bind("guard_configure_seal", "number", ["number"]),
      isConfigured: bind("guard_is_configured", "number", []),
      check: bind("guard_check", "number", ["number"]),
      inputBuffer: bind("guard_input_buffer", "number", []),
      inputCapacity: bind("guard_input_capacity", "number", []),
      responsePtr: bind("guard_response_ptr", "number", []),
      responseLen: bind("guard_response_len", "number", []),
      release: bind("guard_response_release", null, []),
    };
  } catch (error) {
    throw new Error(`lean-checker: module does not export the expected ABI: ${error && error.message}`);
  }

  let poisoned = null; // a code once poisoned, null while healthy
  let calls = 0;

  const inputPtr = api.inputBuffer();
  const capacity = api.inputCapacity();
  if (!Number.isInteger(inputPtr) || inputPtr <= 0 || !Number.isInteger(capacity) || capacity <= 0) {
    throw new Error("lean-checker: module reported no usable input buffer");
  }

  /**
   * One raw call. Writes `text` into the module's static staging buffer, calls
   * `fn(byteLength)`, and reads the response by its explicit length.
   *
   * Never scans for a NUL: a NUL inside a document must not be able to
   * truncate a request, and a NUL inside a response is refused by the shim.
   */
  function invoke(fn, text) {
    if (poisoned) return { status: null, code: poisoned };
    const bytes = encoder.encode(text);
    if (bytes.byteLength > capacity) {
      return { status: null, code: "lean-request-too-long", detail: `${bytes.byteLength} > ${capacity}` };
    }
    let status;
    try {
      Module.HEAPU8.set(bytes, inputPtr);
      calls += 1;
      status = fn(bytes.byteLength);
    } catch (error) {
      // A trap. The instance is not reusable; see the POISONING note above.
      poisoned = "lean-checker-poisoned";
      return { status: null, code: poisoned, detail: String(error && error.message).slice(0, 200) };
    }
    if (status !== 0) return { status, code: shimCode(status) };
    let out;
    try {
      const ptr = api.responsePtr();
      const len = api.responseLen();
      if (!Number.isInteger(len) || len < 0 || len > LEAN_ABI_LIMITS.maxResponseUtf8Bytes) {
        api.release();
        return { status: 0, code: "lean-response-length-invalid", detail: String(len) };
      }
      out = decoder.decode(Module.HEAPU8.subarray(ptr, ptr + len));
      api.release();
    } catch (error) {
      poisoned = "lean-checker-poisoned";
      return { status: null, code: poisoned, detail: String(error && error.message).slice(0, 200) };
    }
    return { status: 0, text: out };
  }

  if (api.init() !== 0) throw new Error("lean-checker: the Lean runtime failed to initialize");

  // The module reports its own identity and bounds, and the frontend refuses to
  // use a module that disagrees. Without this, a module built from a different
  // capability kernel would answer with different tables and nothing would say
  // so.
  const infoCall = invoke(api.info, "");
  if (infoCall.code) throw new Error(`lean-checker: guard_info failed (${infoCall.code}${infoCall.detail ? `: ${infoCall.detail}` : ""})`);
  const info = readInfoResponse(infoCall.text, "info");
  if (!info.ok) throw new Error(`lean-checker: ${info.reason.code}${info.reason.detail ? `: ${info.reason.detail}` : ""}`);
  if (capacity < LEAN_ABI_LIMITS.maxResponseUtf8Bytes / 4) {
    // Not a hard requirement, only a sanity floor: the staging buffer must be
    // able to hold the largest candidate the frontend will forward.
    throw new Error(`lean-checker: input buffer of ${capacity} bytes is too small for this frontend`);
  }

  // Seal the instance. `configureRequest` fixes the field order, so an
  // identical reconfiguration compares byte-equal in the shim and a different
  // one is refused there.
  const configCall = invoke(api.configure, configureRequest({ classes, stylesheetHash }));
  if (configCall.code) {
    throw new Error(`lean-checker: configuration refused (${configCall.code}${configCall.detail ? `: ${configCall.detail}` : ""})`);
  }
  const configured = readInfoResponse(configCall.text, "configure");
  if (!configured.ok) {
    throw new Error(`lean-checker: ${configured.reason.code}${configured.reason.detail ? `: ${configured.reason.detail}` : ""}`);
  }
  if (api.isConfigured() !== 1) throw new Error("lean-checker: the instance did not seal its configuration");

  const identity = Object.freeze({
    abi: info.checker.abi,
    checkerVersion: info.checker.checkerVersion,
    capabilityVersion: info.checker.capabilityVersion,
    profile: info.checker.profile,
    inputCapacity: capacity,
    wasmBytes: wasmBinary.byteLength,
    classes: classes.length,
    stylesheetHash,
    // The module's own compiled-in decoder bounds, as it reported them. They
    // may be looser than the frontend's; they may not be tighter.
    limits: Object.freeze({ ...info.limits }),
  });

  return {
    /** Bounded plain data describing what is actually running. */
    get identity() { return identity; },
    get poisoned() { return poisoned !== null; },
    get calls() { return calls; },

    /**
     * Check one bounded candidate tree without normalization.
     *
     * Returns `{ status: "accepted", tree }`
     * with the tree Lean's `acceptCandidate` returned, or
     * `{ status: "rejected", reasons }`, or
     * `{ status: "error", reason }`. Never throws, and never returns a tree
     * except with `accepted`.
     */
    check(requestId, document) {
      if (poisoned) return refusal(poisoned);
      let request;
      try {
        request = checkRequest(requestId, document);
      } catch (error) {
        return refusal("lean-request-malformed", error && error.message);
      }
      const call = invoke(api.check, request);
      if (call.code) return refusal(call.code, call.detail);
      return readCheckResponse(call.text, requestId);
    },

    /**
     * Attempting to reconfigure a sealed instance must fail. Exposed so the
     * negative controls can demonstrate the seal rather than assume it; the
     * policy Worker never calls it.
     */
    tryReconfigure(nextClasses, nextStylesheetHash) {
      if (poisoned) return refusal(poisoned);
      let request;
      try {
        request = configureRequest({ classes: nextClasses, stylesheetHash: nextStylesheetHash });
      } catch (error) {
        return refusal("lean-request-malformed", error && error.message);
      }
      const call = invoke(api.configure, request);
      if (call.code) return refusal(call.code, call.detail);
      const parsed = readInfoResponse(call.text, "configure");
      return parsed.ok ? { status: "configured" } : refusal(parsed.reason.code, parsed.reason.detail);
    },

    /** Release any outstanding response buffer. Idempotent. */
    dispose() {
      try { api.release(); } catch { /* a poisoned instance has nothing to release */ }
    },
  };
}
