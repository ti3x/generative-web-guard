// Runtime transport protocol for the QuickJS boundary.
//
// This module is the single definition of the message shape, the protocol
// version and every size limit used on either side of the worker boundary.
// The worker validates the requests it receives and the results it produces;
// the controller validates every reply again before it commits state or hands
// a view on towards markup validation. Neither file keeps a private copy of
// these numbers: a limit is defined here or it does not exist.
//
// The guest chooses the *contents* of a state or view string. It never chooses
// the shape of a message, the name of a field, or the length of one. Shape
// checks are exact in both directions: a missing field and an unexpected field
// are equally a protocol failure, never something to coerce or ignore.

// Bump when the wire shape below changes. Controller and worker are built from
// the same sources, so a mismatch means a stale bundle, not a guest attack; it
// still fails closed rather than guessing at the older shape.
export const PROTOCOL_VERSION = 1;

export const DEFAULT_LIMITS = Object.freeze({
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  loadMs: 500,
  stepMs: 200,
  maxViewChars: 400000,
  maxStateChars: 1000000,
  maxSourceChars: 200000,
  maxDataChars: 4 * 1024 * 1024,
  maxEventChars: 64 * 1024,
  // Longest diagnostic string that may be copied out of the guest or relayed
  // to the host. Anything longer is dropped, not truncated: truncating would
  // mean copying the oversized string out first.
  maxDiagnosticChars: 2000,
  dataMs: 2000,
});

// --- derived transport bounds -----------------------------------------------
//
// Several host allocations hold a JSON-escaped copy of guest-sized text: the
// step program embeds the state and event as JSON string literals, and the
// load program embeds the source and the host dataset the same way.
//
// JSON escaping can expand one UTF-16 code unit into six characters: a C0
// control or a lone surrogate becomes a six-character escape such as
// \u001f or \ud800, while `"` and `\` become two characters. Six is
// therefore the per-code-unit upper bound, and a template adds a fixed
// amount of its own text:
//
//   packedChars(n) = 6 * n + TEMPLATE_OVERHEAD_CHARS
//
// With the default limits that gives, in characters:
//
//   step program  6 * (1_000_000 state + 65_536 event)  + 1024 =  6_394_240
//   load program  6 * (  200_000 source + 4_194_304 data) + 1024 = 26_367_848
//   packed packet 6 * (1_000_000 state + 400_000 view)   + 1024 =  8_401_024
//
// MAX_ALLOCATION_CHARS caps the largest single transport allocation the
// runtime may ever be configured to request (32 Mi characters, about 64 MB as
// UTF-16). resolveLimits refuses a configuration whose derived bounds exceed
// it, so an oversized limit fails at construction instead of at the first
// hostile document.
export const JSON_ESCAPE_FACTOR = 6;
export const TEMPLATE_OVERHEAD_CHARS = 1024;
export const MAX_ALLOCATION_CHARS = 32 * 1024 * 1024;

export function packedChars(chars) {
  return JSON_ESCAPE_FACTOR * chars + TEMPLATE_OVERHEAD_CHARS;
}

// Upper bound on the generated step program: state and event as JSON literals.
export function stepProgramLimit(limits) {
  return packedChars(limits.maxStateChars + limits.maxEventChars);
}

// Upper bound on the generated load program: source plus the embedded dataset.
export function loadProgramLimit(limits) {
  return packedChars(limits.maxSourceChars + limits.maxDataChars);
}

// Upper bound on a JSON-packed { state, view } packet. Nothing packs the two
// fields into one string today — they are extracted separately and each is
// capped on its own — but this is the ceiling any packed form of a reply would
// have to fit, so it is checked against MAX_ALLOCATION_CHARS with the rest.
export function packetLimit(limits) {
  return packedChars(limits.maxStateChars + limits.maxViewChars);
}

const POSITIVE_LIMITS = [
  "memoryBytes", "stackBytes", "loadMs", "stepMs", "dataMs",
  "maxViewChars", "maxStateChars", "maxSourceChars", "maxDataChars",
  "maxEventChars", "maxDiagnosticChars",
];

// Merges caller limits over the defaults and rejects a configuration that
// could ask the host for an unbounded allocation. Both sides of the boundary
// call this, so both agree on the numbers they are enforcing.
export function resolveLimits(limits = {}) {
  if (limits === null || typeof limits !== "object") throw new Error("limits must be an object");
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  for (const key of POSITIVE_LIMITS) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`limit ${key} must be a positive safe integer`);
    }
  }
  for (const [name, derived] of [
    ["step program", stepProgramLimit(resolved)],
    ["load program", loadProgramLimit(resolved)],
    ["packet", packetLimit(resolved)],
  ]) {
    if (derived > MAX_ALLOCATION_CHARS) {
      throw new Error(`limits allow a ${name} of ${derived} characters, above the ${MAX_ALLOCATION_CHARS} ceiling`);
    }
  }
  return Object.freeze(resolved);
}

// --- message shape ----------------------------------------------------------

const ENVELOPE_FIELDS = ["v", "id", "type"];

// Exact payload fields per request type, with the limit that bounds each one.
const REQUEST_FIELDS = Object.freeze({
  load: Object.freeze({ source: "maxSourceChars", data: "maxDataChars" }),
  init: Object.freeze({}),
  step: Object.freeze({ state: "maxStateChars", event: "maxEventChars" }),
});

export const REQUEST_TYPES = Object.freeze(Object.keys(REQUEST_FIELDS));

// data and event are nullable: the host may have no dataset and init has no
// event. Every other payload field must be a present string.
const NULLABLE_FIELDS = Object.freeze(["data", "event"]);

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${label} is not an object`;
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) return `${label} has an unexpected field "${key}"`;
  }
  for (const key of allowed) {
    if (!keys.includes(key)) return `${label} is missing field "${key}"`;
  }
  return null;
}

function checkBoundedString(value, max, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") return `${label} is not a string`;
  if (value.length > max) return `${label} too large: ${value.length} > ${max}`;
  return null;
}

function checkId(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return `${label} has an invalid id`;
  return null;
}

// Validates a request received by the worker. Returns null when the request is
// acceptable, otherwise a bounded, host-written description of the problem.
export function checkRequest(msg, limits = DEFAULT_LIMITS) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return "request is not an object";
  if (msg.v !== PROTOCOL_VERSION) return `request protocol version ${describeScalar(msg.v)} is not ${PROTOCOL_VERSION}`;
  const badId = checkId(msg.id, "request");
  if (badId) return badId;
  if (typeof msg.type !== "string" || !REQUEST_TYPES.includes(msg.type)) {
    return `unknown request type ${describeScalar(msg.type)}`;
  }
  const payload = REQUEST_FIELDS[msg.type];
  const shape = exactKeys(msg, [...ENVELOPE_FIELDS, ...Object.keys(payload)], "request");
  if (shape) return shape;
  for (const [field, limitName] of Object.entries(payload)) {
    const problem = checkBoundedString(msg[field], limits[limitName], `request ${field}`, {
      nullable: NULLABLE_FIELDS.includes(field),
    });
    if (problem) return problem;
  }
  return null;
}

// Validates the result the worker is about to return, or has just returned,
// for a given request type. load reports a fixed acknowledgement so that its
// result has a checkable shape like the others.
export function checkResult(type, result, limits = DEFAULT_LIMITS) {
  if (type === "load") {
    const shape = exactKeys(result, ["loaded"], "load result");
    if (shape) return shape;
    return result.loaded === true ? null : "load result is not an acknowledgement";
  }
  const shape = exactKeys(result, ["state", "view"], `${type} result`);
  if (shape) return shape;
  return (
    checkBoundedString(result.state, limits.maxStateChars, `${type} result state`) ||
    checkBoundedString(result.view, limits.maxViewChars, `${type} result view`)
  );
}

// Validates a reply received by the controller against the request that is
// actually outstanding. A stale, duplicate, unexpected or mismatched reply is
// reported as a problem so the caller can settle the active job and stop the
// session rather than waiting for a watchdog.
export function checkReply(msg, { id, type, limits = DEFAULT_LIMITS } = {}) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return "reply is not an object";
  if (msg.v !== PROTOCOL_VERSION) return `reply protocol version ${describeScalar(msg.v)} is not ${PROTOCOL_VERSION}`;
  const badId = checkId(msg.id, "reply");
  if (badId) return badId;
  if (typeof msg.ok !== "boolean") return "reply has no ok flag";
  if (id === undefined || type === undefined) return `unexpected reply ${msg.id} with no request outstanding`;
  if (msg.id !== id) return `reply id ${msg.id} does not match outstanding request ${id}`;
  const shape = exactKeys(msg, ["v", "id", "ok", msg.ok ? "result" : "error"], "reply");
  if (shape) return shape;
  if (!msg.ok) return checkBoundedString(msg.error, limits.maxDiagnosticChars, "reply error");
  return checkResult(type, msg.result, limits);
}

// Bounded description of a scalar for use in the host's own diagnostics. Only
// primitives are described; an object is never coerced to a string here.
function describeScalar(value) {
  const type = typeof value;
  if (value === null) return "null";
  if (type === "string") return value.length > 32 ? `a ${value.length}-character string` : JSON.stringify(value);
  if (type === "number" || type === "boolean" || type === "undefined") return String(value);
  return `a ${type}`;
}

// Bounded error text for a failure raised on the host side of the boundary.
// A thrown value that is not an Error with a string message gets a generic
// description: coercing an unknown value would hand message construction to
// whatever defined its toString.
export function errorText(err, maxChars = DEFAULT_LIMITS.maxDiagnosticChars) {
  const message = err instanceof Error && typeof err.message === "string" ? err.message : null;
  if (message === null) return "runtime failed";
  return message.length > maxChars ? message.slice(0, maxChars) : message;
}
