// Policy-Worker protocol and preprocessing limits.
//
// This module is the single source of truth for
//   * the versioned message envelope spoken between the host and the policy
//     Worker (src/policy-client.js <-> src/policy-worker.js), and
//   * the input limits that bound preprocessing BEFORE parse5 runs and while
//     the raw tree is converted.
//
// UNITS. Every limit names its unit and the names are used consistently:
//   *CodeUnits  -> UTF-16 code units, i.e. JavaScript `String.prototype.length`.
//                  A non-BMP character such as an emoji counts as 2.
//   *Utf8Bytes  -> bytes of the UTF-8 encoding of that string, counted with
//                  utf8ByteLength() below (no allocation, no TextEncoder).
//   *Ms         -> wall-clock milliseconds.
//   everything else is a plain count of nodes/attributes/records.
//
// The policy limits in rules/policy.json bound the OUTPUT tree. The limits
// here bound the INPUT work: they are deliberately checked even when the
// policy would later discard the node that caused the work (5,000 nested
// <div>s cost the same to parse and walk whether they are kept, unwrapped or
// dropped). They are not a substitute for the output policy; both apply.
//
// Nothing here executes generated JavaScript, and the policy Worker must
// never gain that ability: it only parses markup and builds candidate trees.

// The QuickJS boundary owns its own protocol and limits in
// src/runtime/protocol.js. This module imports them rather than restating any
// number, so that the largest view the runtime may forward can never exceed
// what this frontend will accept.
import { DEFAULT_LIMITS as RUNTIME_LIMITS } from "./runtime/protocol.js";

export const POLICY_PROTOCOL_VERSION = 1;

// Host- or generator-supplied HTML, in UTF-16 code units. Guest views are
// already bounded by the runtime; the frontend limit is the larger of the two
// so a legally sized view is never rejected for its length here.
const HOST_DOCUMENT_CODE_UNITS = 512_000;

/** Message types. `kind` is always one of these exact strings. */
export const POLICY_MESSAGE = Object.freeze({
  // host -> worker
  //   preprocess    one bounded HTML string. Every request declares its
  //                 `delivery` (POLICY_DELIVERY): a session with a frame says
  //                 "frame" and the Worker refuses to serve it until it holds
  //                 the port; a headless diagnostic session says "host" and the
  //                 Worker refuses it while a port is installed. The Worker
  //                 therefore never chooses where a tree goes by inference.
  preprocess: "policy/preprocess",
  //   attachFrame   hands the Worker its end of the private port to the frame
  //                 (src/frame-protocol.js); the MessagePort travels in the
  //                 transfer list. From then on accepted trees go to the frame
  //                 over that port and the host receives `rendered` results
  //                 that carry no tree.
  attachFrame: "policy/attach-frame",
  // worker -> host
  //   ready         the payload loaded and the channel works (channel-handshake
  //                 stage). Posted before the checker exists, so it says
  //                 nothing about whether anything can be accepted yet.
  //   checkerReady  the Lean/Wasm authority instantiated, sealed its
  //                 configuration and reported an identity this build accepts
  //                 (wasm-init stage). Until this arrives no document can be
  //                 accepted; requests wait in the Worker's bounded queue.
  //   failed        the authority could not start. There is no fallback: the
  //                 session can never accept a document and must be replaced.
  ready: "policy/ready",
  checkerReady: "policy/checker-ready",
  //   frameAttached the Worker installed the port it was handed; from now on a
  //                 reply that still carries a tree is a protocol violation.
  frameAttached: "policy/frame-attached",
  failed: "policy/failed",
  result: "policy/result",
  // worker -> host, protocol-level refusal (bad envelope, unknown kind)
  refused: "policy/refused",
});

/** How many requests the Worker holds while the checker is still starting. */
export const POLICY_STARTUP_QUEUE_MAX = 8;

/** Where a request's accepted tree may go. Declared by the host on every request. */
export const POLICY_DELIVERY = Object.freeze({
  /** Only over the private port to the frame; the host reply carries no tree. */
  frame: "frame",
  /** Back to the host as headless diagnostics; no frame may be attached. */
  host: "host",
});

/**
 * The Worker's delivery check, before any parsing work. Returns a bounded
 * refusal reason, or null when the declared delivery matches the Worker's
 * actual port state. Shared with the Node Worker stand-in so the tests
 * exercise the same rule the production entry applies.
 *
 *   frame declared, no port installed   -> frame-not-attached
 *   host declared, a port is installed  -> delivery-mismatch
 *   anything else declared              -> delivery-unspecified
 */
export function deliveryRefusal(message, hasFramePort) {
  const delivery = message && message.delivery;
  if (delivery === POLICY_DELIVERY.frame) {
    return hasFramePort ? null : { code: "frame-not-attached", detail: "the request requires the private frame port, which this Worker does not hold yet" };
  }
  if (delivery === POLICY_DELIVERY.host) {
    return hasFramePort ? { code: "delivery-mismatch", detail: "a Worker holding a frame port never returns a tree to the host" } : null;
  }
  return { code: "delivery-unspecified" };
}

export const PREPROCESS_LIMITS = Object.freeze({
  // ---- source text, checked before parse5 is invoked --------------------
  maxSourceCodeUnits: Math.max(HOST_DOCUMENT_CODE_UNITS, RUNTIME_LIMITS.maxViewChars),

  // ---- raw tree, checked while converting parse5 output ------------------
  // Raw nodes the frontend will forward, including text, comments, doctypes
  // and elements the policy will drop. A CAPACITY bound: it equals the
  // policy's own maxNodes, and a raw tree never has fewer nodes than the
  // output built from it, so preprocessing refuses first. The Lean module's
  // decoder bound is deliberately looser (6,000, Guard.Io.abiLimits); the glue
  // requires the module's bound to be no TIGHTER than this one, so the decoder
  // can never refuse a document preprocessing accepted.
  maxRawNodes: 5_000,
  // Raw nodes still OPEN in a depth-first walk when a node is reached: its
  // ancestors, itself, and every earlier sibling of each of them. For a flat
  // list of siblings this is just the node's position.
  //
  // MEASURED PER ENGINE, not chosen for symmetry, and it is the tightest
  // number in this file for a reason.
  //
  // The Lean checker recurses once per SIBLING -- `nodesToRaw`, `treeStats`
  // and `nodesPolicyOk` each recurse over sibling lists inside `mutual`
  // blocks, which Lean does not turn into loops -- and once per level. That
  // recursion compiles to WebAssembly function calls whose depth is bounded by
  // THE ENGINE'S OWN CALL STACK. `-sSTACK_SIZE` configures the linear-memory
  // stack and does not bound it at all; the audit measured 104 bytes of linear
  // stack for every case. Lean's termination proofs bound steps, not stack, so
  // this is an independent obligation and it is discharged here, on the input.
  //
  // What the recursion has open when it reaches a node is exactly the count
  // above, not the document's node total. Measured with the real checker at a
  // reduced V8 stack (`node --stack-size=250`): a flat list trapped between
  // 1,700 and 1,800 siblings, and a 30-level chain descending through the
  // LAST child of a 58-wide level (1,710 open, 1,741 nodes) trapped too --
  // while the same 1,921-node tree descending through the FIRST child (never
  // more than 71 open) was accepted, as were wide, shallow trees of 4,368 and
  // 4,680 nodes. A 100x8 table (2,733 raw nodes, 218 open at most) and a
  // 300-item list (2,102 raw nodes, 604 open) both pass under that same
  // reduced stack. Nesting costs a few frames per level on top; the browser
  // checks drive the deepest, widest shape this file permits on every engine.
  //
  // Per engine, by sending flat documents of increasing width through the real
  // policy Worker (for a flat list, open nodes == siblings):
  //
  //   Node 22 / V8      9,000 siblings fine, 9,500 overflowed
  //   Firefox 141       5,800 fine, 6,000 overflowed
  //   WebKit 26         2,000 fine over 10 calls, 2,500 overflowed on the
  //                     SECOND identical call -- the threshold moves with JIT
  //                     tier-up, so it is not a number to sit close to
  //   Chromium 140      no overflow at any width the frontend permits
  //
  // 1,000 is 2.5x below WebKit's observed failure and was clean over 10
  // consecutive calls on all three engines. Bounding this quantity instead of
  // the node total is what lets an ordinary 50-row table through: under a
  // 1,000-node cap it was refused. Raising the number needs the per-sibling
  // recursion in the checker to become iterative, which remains future work.
  // Phase 6 also applies this same bound to the proposed output: unwrapping
  // may increase sibling width even when the raw tree has a small path count.
  //
  // A document that overflows anyway is still a bounded failure and never a
  // render: the trap poisons the checker instance (src/lean-checker.js), the
  // request is refused, and the host replaces the Worker. That path is
  // exercised in test/lean-authority.test.js. The module does not enforce this
  // bound itself; its node backstop plus poisoning cover a direct caller.
  maxRawPathNodes: 1_000,
  // Raw tree levels. Larger than the policy's maxDepth (32) because
  // unwrapped elements collapse levels, but small enough that the downstream
  // checker's per-level recursion cannot exhaust the JS stack.
  maxRawDepth: 192,
  // Non-element, non-text raw nodes (comments, doctypes, unknown): a comment
  // flood is input work even though every comment is discarded. Kept BELOW
  // maxRawNodes so it remains a reachable, meaningful bound rather than dead
  // configuration that the general node bound always trips first.
  maxRawCommentNodes: 400,
  // Per element.
  maxRawAttrsPerElement: 256,
  maxRawAttrBytesUtf8PerElement: 64_000,
  // Qualified element/attribute names. Long names are a work amplifier and
  // no legitimate name approaches this.
  maxRawNameCodeUnits: 128,
  // Per text node and summed over the document.
  maxRawTextCodeUnits: 200_000,
  maxRawTotalTextCodeUnits: 1_000_000,
  // Total candidate payload accounted during the walk (names, attribute
  // names/values and text, in UTF-8 bytes) and again on the serialized
  // candidate before it is posted.
  maxCandidateUtf8Bytes: 2_000_000,

  // ---- budgets ----------------------------------------------------------
  // Cooperative budget for the adapter's own walk. It cannot interrupt
  // parse5 itself; only Worker termination can (see src/policy-client.js).
  maxPreprocessMs: 1_000,

  // ---- diagnostics returned to the host ---------------------------------
  maxDiagnosticRecords: 200,
  maxDiagnosticsUtf8Bytes: 16_000,
  maxDetailCodeUnits: 200,
});

/**
 * Host-side request budget. Exceeding it terminates the Worker.
 *
 * `startupMs` covers the FIRST request on a fresh session, which now waits
 * behind Lean/Wasm instantiation. It is deliberately larger than the
 * `wasm-init` stage budget plus an ordinary request, so a cold compile cannot
 * make the first request time out before the stage that owns it reports its
 * own code. Collapsing the two would report `timeout` for what is really
 * `csp-wasm-unsafe-eval`.
 */
export const POLICY_TIMEOUTS = Object.freeze({
  requestMs: 5_000,
  startupMs: 20_000,
});

/**
 * UTF-8 byte length of a JavaScript string, without allocating an encoder or
 * a buffer. Lone surrogates are counted as the 3 bytes a replacement
 * character would occupy, which is what every encoder emits for them.
 */
export function utf8ByteLength(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The defined structured rejection value. Preprocessing never throws a string
 * and never throws across the Worker boundary: it returns one of these.
 *   code       stable machine code
 *   limit      name of the exceeded limit in PREPROCESS_LIMITS, when any
 *   limitValue configured value of that limit
 *   observed   measured value that exceeded it
 *   detail     bounded human-readable text (never guest-controlled data)
 */
export function policyRejection(code, fields = {}) {
  const reason = { code };
  for (const key of ["limit", "limitValue", "observed", "depth", "tag", "attr", "index"]) {
    if (fields[key] !== undefined) reason[key] = fields[key];
  }
  if (typeof fields.detail === "string") {
    reason.detail = fields.detail.slice(0, PREPROCESS_LIMITS.maxDetailCodeUnits);
  }
  return { status: "rejected", reason };
}

/** True for a well-formed envelope addressed to this instance/session. */
export function isPolicyEnvelope(message, expect = {}) {
  if (!message || typeof message !== "object") return false;
  if (message.protocol !== POLICY_PROTOCOL_VERSION) return false;
  if (typeof message.kind !== "string") return false;
  if (typeof message.instanceId !== "string" || message.instanceId.length === 0) return false;
  if (typeof message.sessionId !== "string" || message.sessionId.length === 0) return false;
  if (!Number.isInteger(message.generation) || message.generation < 0) return false;
  if (!Number.isInteger(message.requestId) || message.requestId < 0) return false;
  if (expect.instanceId !== undefined && message.instanceId !== expect.instanceId) return false;
  if (expect.sessionId !== undefined && message.sessionId !== expect.sessionId) return false;
  return true;
}

/** Copy the identity fields of a request onto a reply. */
export function replyEnvelope(request, kind, body) {
  return {
    protocol: POLICY_PROTOCOL_VERSION,
    kind,
    instanceId: request.instanceId,
    sessionId: request.sessionId,
    generation: request.generation,
    requestId: request.requestId,
    ...body,
  };
}

/**
 * Bound the diagnostics that leave the Worker: record count first, then the
 * serialized size. Diagnostics are host-UI data, never authorization.
 */
export function boundDiagnostics(records, limits = PREPROCESS_LIMITS) {
  const list = Array.isArray(records) ? records : [];
  const kept = [];
  let bytes = 0;
  let truncated = list.length > limits.maxDiagnosticRecords;
  for (const record of list.slice(0, limits.maxDiagnosticRecords)) {
    const size = utf8ByteLength(JSON.stringify(record));
    if (bytes + size > limits.maxDiagnosticsUtf8Bytes) { truncated = true; break; }
    bytes += size;
    kept.push(record);
  }
  return { records: kept, total: list.length, truncated, bytes };
}
