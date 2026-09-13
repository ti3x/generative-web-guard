// The JavaScript half of the versioned single-document Lean/Wasm ABI.
//
// This module owns the wire contract and nothing else: it does not instantiate
// WebAssembly (src/lean-checker.js does) and it does not decide policy (Lean
// does). It exists separately so that the request builder, the response
// validator and the version constants are one thing that both sides of the
// boundary and the tests can point at.
//
// THE CONTRACT
//
//   configure  { abi, op: "configure", profile, classes, stylesheetHash }
//   check      { abi, op: "check", requestId, document }
//   response   { abi, op, requestId, checker: { abi, checkerVersion,
//                capabilityVersion, profile }, status, ... }
//
// `status` is one of `accepted`, `rejected`, `configured`, `info` or `error`.
// Only `accepted` carries a `tree`, and that tree is the one Lean's `checkTree`
// returned. Anything unexpected -- a version mismatch, an unknown status, a
// missing field, a tree that is not tree-shaped, a request id that is not the
// one we sent -- is a refusal here, never a render.
//
// WHAT IS BOUND TO THE BUILT INSTANCE
//
// The profile, the policy tables, the checker's own limits and the checker
// version are compile-time constants inside the module. The class allowlist
// and the stylesheet identity are sealed once at startup from the build-time
// frame manifest. A `check` request carries a document and a request id, and
// nothing else; the Lean decoder rejects a request that carries a `classes`,
// `profile` or `limits` field as an unknown field. So there is no field on the
// hot path through which generated content could influence the policy.

import { CAPABILITY_VERSION } from "./capabilities-data.js";
import { isTreeShaped } from "./tree.js";
import { PREPROCESS_LIMITS, utf8ByteLength } from "./policy-protocol.js";

/** ABI generation. Both sides check it; a mismatch is a startup failure. */
export const LEAN_ABI_VERSION = 1;

/** The only profile a shipped build can apply. There is no profile loader. */
export const LEAN_PROFILE = "default";

/**
 * The checker identity this build of the JavaScript expects the module to
 * report. It is derived the same way `Guard.Io.checkerVersion` derives it, so
 * a module compiled from a different capability kernel is refused instead of
 * silently answering with different tables.
 *
 * This states intent. It does not establish that the bytes are the bytes that
 * were built and tested; the asset hashes in the build manifest are what
 * detect a content mismatch.
 */
export const LEAN_CHECKER_VERSION = `guard-checker/${LEAN_ABI_VERSION}.${CAPABILITY_VERSION}`;

/**
 * The MINIMUM decoder bounds the module must report.
 *
 * The contract is `module >= frontend`, not equality: the module's decoder
 * must never be TIGHTER than the frontend, because then it could refuse a
 * document preprocessing already accepted, and the refusal would look like a
 * policy decision. Looser is fine and is deliberate for `maxRawNodes`: the
 * frontend's is a capacity bound equal to the policy's maxNodes, while the
 * module's is a backstop for a caller that hands the checker a raw tree
 * directly. The bound that actually protects the checker's per-sibling
 * recursion is the frontend's `maxRawPathNodes` (see src/policy-protocol.js),
 * which the module does not report: a direct caller is covered by the node
 * backstop plus poisoning on a trap, not by this comparison.
 *
 * A drift in the wrong direction is a startup failure, not a mysterious
 * rejection later.
 */
export const LEAN_MIN_LIMITS = Object.freeze({
  maxRawNodes: PREPROCESS_LIMITS.maxRawNodes,
  maxRawDepth: PREPROCESS_LIMITS.maxRawDepth,
  maxRawAttrsPerElement: PREPROCESS_LIMITS.maxRawAttrsPerElement,
  maxRawNameCodeUnits: PREPROCESS_LIMITS.maxRawNameCodeUnits,
  maxRawTextCodeUnits: PREPROCESS_LIMITS.maxRawTextCodeUnits,
  maxRawTotalTextCodeUnits: PREPROCESS_LIMITS.maxRawTotalTextCodeUnits,
});

/** Bounds on the protocol strings themselves. */
export const LEAN_ABI_LIMITS = Object.freeze({
  maxRequestIdCodeUnits: 128,
  maxStylesheetHashCodeUnits: 128,
  maxClasses: 512,
  maxClassCodeUnits: 128,
  /** Ceiling on a response we will even look at, in UTF-8 bytes. */
  maxResponseUtf8Bytes: 8_000_000,
});

/** Status codes the shim returns. Negative values never install a response. */
export const LEAN_STATUS = Object.freeze({
  ok: 0,
  init: -1,
  length: -2,
  utf8: -3,
  sealed: -4,
  notConfigured: -5,
  alloc: -6,
  responseTooLarge: -7,
  responseNul: -8,
  configRefused: -9,
  busy: -10,
});

const SHIM_CODES = Object.freeze({
  [LEAN_STATUS.init]: "lean-init-failed",
  [LEAN_STATUS.length]: "lean-request-too-long",
  [LEAN_STATUS.utf8]: "lean-request-not-utf8",
  [LEAN_STATUS.sealed]: "lean-configuration-sealed",
  [LEAN_STATUS.notConfigured]: "lean-not-configured",
  [LEAN_STATUS.alloc]: "lean-allocation-failed",
  [LEAN_STATUS.responseTooLarge]: "lean-response-too-large",
  [LEAN_STATUS.responseNul]: "lean-response-embedded-nul",
  [LEAN_STATUS.configRefused]: "lean-configuration-refused",
  [LEAN_STATUS.busy]: "lean-reentrant-call",
});

/** Map a shim status to a stable machine code. Never throws. */
export function shimCode(status) {
  return SHIM_CODES[status] ?? `lean-status-${status}`;
}

/**
 * Build the sealed configuration. Called once per instance by trusted glue
 * with values that come from the build-time frame manifest, never from a
 * message and never from generated content.
 */
export function configureRequest({ classes, stylesheetHash }) {
  if (!Array.isArray(classes)) throw new TypeError("lean-abi: classes must be an array");
  if (classes.length > LEAN_ABI_LIMITS.maxClasses) throw new TypeError("lean-abi: too many classes");
  const seen = new Set();
  for (const c of classes) {
    if (typeof c !== "string" || c.length === 0) throw new TypeError("lean-abi: class must be a non-empty string");
    if (c.length > LEAN_ABI_LIMITS.maxClassCodeUnits) throw new TypeError("lean-abi: class name too long");
    if (seen.has(c)) throw new TypeError(`lean-abi: duplicate class ${c}`);
    seen.add(c);
  }
  if (typeof stylesheetHash !== "string" || stylesheetHash.length === 0
      || stylesheetHash.length > LEAN_ABI_LIMITS.maxStylesheetHashCodeUnits) {
    throw new TypeError("lean-abi: stylesheetHash must be a bounded non-empty string");
  }
  // Field order is fixed so the sealed bytes are deterministic: the shim seals
  // the exact bytes, and an identical reconfiguration must compare equal.
  return JSON.stringify({
    abi: LEAN_ABI_VERSION,
    op: "configure",
    profile: LEAN_PROFILE,
    classes: [...classes],
    stylesheetHash,
  });
}

/** Build one document request. `document` is the bounded raw tree. */
export function checkRequest(requestId, document) {
  if (typeof requestId !== "string" || requestId.length === 0
      || requestId.length > LEAN_ABI_LIMITS.maxRequestIdCodeUnits) {
    throw new TypeError("lean-abi: requestId must be a bounded non-empty string");
  }
  return JSON.stringify({ abi: LEAN_ABI_VERSION, op: "check", requestId, document });
}

function badEnvelope(code, detail) {
  return { ok: false, reason: detail === undefined ? { code } : { code, detail: String(detail).slice(0, 200) } };
}

/**
 * Validate a response envelope: version, op, echoed request id and the
 * reported checker identity. Returns `{ ok: true, message }` or
 * `{ ok: false, reason }`. This is the only place a response becomes
 * something the rest of the code will look at.
 */
export function parseResponse(text, { op, requestId = "" } = {}) {
  if (typeof text !== "string") return badEnvelope("lean-response-not-string");
  if (text.length === 0) return badEnvelope("lean-response-empty");
  if (utf8ByteLength(text) > LEAN_ABI_LIMITS.maxResponseUtf8Bytes) return badEnvelope("lean-response-too-large");
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return badEnvelope("lean-response-not-json", error && error.message);
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return badEnvelope("lean-response-not-object");
  }
  if (message.abi !== LEAN_ABI_VERSION) return badEnvelope("lean-abi-mismatch", message.abi);
  if (message.op !== op) return badEnvelope("lean-op-mismatch", message.op);
  if (typeof message.requestId !== "string" || message.requestId !== requestId) {
    return badEnvelope("lean-request-id-mismatch", message.requestId);
  }
  const checker = message.checker;
  if (checker === null || typeof checker !== "object" || Array.isArray(checker)) {
    return badEnvelope("lean-checker-identity-missing");
  }
  if (checker.abi !== LEAN_ABI_VERSION) return badEnvelope("lean-abi-mismatch", checker.abi);
  if (checker.checkerVersion !== LEAN_CHECKER_VERSION) {
    return badEnvelope("lean-checker-version-mismatch", checker.checkerVersion);
  }
  if (checker.capabilityVersion !== CAPABILITY_VERSION) {
    return badEnvelope("lean-capability-version-mismatch", checker.capabilityVersion);
  }
  if (checker.profile !== LEAN_PROFILE) return badEnvelope("lean-profile-mismatch", checker.profile);
  if (typeof message.status !== "string") return badEnvelope("lean-status-missing");
  return { ok: true, message };
}

const ALLOWED_STATUS = Object.freeze({
  configure: new Set(["configured", "error"]),
  info: new Set(["info", "error"]),
  check: new Set(["accepted", "rejected", "error"]),
});

/**
 * Interpret a `check` response. Returns one of
 *   { status: "accepted", tree, changes, changeKinds, changeRules }
 *   { status: "rejected", reasons }
 *   { status: "error", reason }
 *
 * A response that claims `accepted` without a well-formed tree is an error,
 * not an acceptance: "Lean said yes" is not a licence to render whatever
 * happens to be in the message.
 */
export function readCheckResponse(text, requestId) {
  const parsed = parseResponse(text, { op: "check", requestId });
  if (!parsed.ok) return { status: "error", reason: parsed.reason };
  const message = parsed.message;
  if (!ALLOWED_STATUS.check.has(message.status)) {
    return { status: "error", reason: { code: "lean-unknown-status", detail: String(message.status).slice(0, 60) } };
  }
  if (message.status === "error") {
    return { status: "error", reason: { code: "lean-protocol-error", detail: String(message.error ?? "").slice(0, 200) } };
  }
  if (message.status === "rejected") {
    const reasons = Array.isArray(message.reasons)
      ? message.reasons.filter((r) => typeof r === "string").slice(0, 64).map((r) => r.slice(0, 80))
      : [];
    // A rejection must not smuggle a tree back. Refuse the whole response if
    // it does, rather than quietly ignoring the extra field.
    if ("tree" in message) return { status: "error", reason: { code: "lean-rejected-with-tree" } };
    return { status: "rejected", reasons };
  }
  const tree = message.tree;
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    return { status: "error", reason: { code: "lean-accepted-without-tree" } };
  }
  if (tree.kind !== "root" || !Array.isArray(tree.children)) {
    return { status: "error", reason: { code: "lean-tree-not-root" } };
  }
  if (!isTreeShaped(tree)) {
    return { status: "error", reason: { code: "lean-tree-malformed" } };
  }
  if (!Number.isInteger(message.changes) || message.changes < 0) {
    return { status: "error", reason: { code: "lean-changes-not-count" } };
  }
  const kinds = Array.isArray(message.changeKinds) ? message.changeKinds : null;
  const rules = Array.isArray(message.changeRules) ? message.changeRules : null;
  if (kinds === null || rules === null || kinds.length !== message.changes || rules.length !== message.changes) {
    return { status: "error", reason: { code: "lean-change-records-inconsistent" } };
  }
  return {
    status: "accepted",
    tree,
    changes: message.changes,
    changeKinds: kinds.map((k) => String(k).slice(0, 60)),
    changeRules: rules.map((r) => String(r).slice(0, 60)),
  };
}

/**
 * Interpret an `info` or `configure` response and check the module's compiled
 * bounds against `LEAN_MIN_LIMITS`.
 */
export function readInfoResponse(text, op = "info") {
  const parsed = parseResponse(text, { op });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const message = parsed.message;
  if (!ALLOWED_STATUS[op].has(message.status)) {
    return { ok: false, reason: { code: "lean-unknown-status", detail: String(message.status).slice(0, 60) } };
  }
  if (message.status === "error") {
    return { ok: false, reason: { code: "lean-protocol-error", detail: String(message.error ?? "").slice(0, 200) } };
  }
  const limits = message.limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    return { ok: false, reason: { code: "lean-limits-missing" } };
  }
  for (const [key, minimum] of Object.entries(LEAN_MIN_LIMITS)) {
    if (!Number.isInteger(limits[key])) {
      return { ok: false, reason: { code: "lean-limits-mismatch", detail: `${key}: module reported ${limits[key]}` } };
    }
    if (limits[key] < minimum) {
      return {
        ok: false,
        reason: { code: "lean-limits-mismatch", detail: `${key}: module ${limits[key]} is tighter than the frontend's ${minimum}` },
      };
    }
  }
  return { ok: true, checker: message.checker, limits, message };
}
