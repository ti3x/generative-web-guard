// Bounded verdict identity records, minted beside Lean's verdict. These are
// diagnostic metadata, not a public frame-render capability. The production
// client checks their identity; trees travel only over the private Worker port.
//
// createAcceptanceRegistry below is retained solely as a reference/test utility
// for the retired token route. It is not used by the production client or frame,
// and is not exported by the CDN entries. Neither records nor this registry
// authenticate an arbitrary host-supplied tree; trusted glue remains in scope.

/** Nonce size. 128 bits of randomness, hex encoded. */
export const ACCEPTANCE_NONCE_BYTES = 16;

/** How many unclaimed acceptances a session keeps. Bounded on purpose: each
 * one pins an accepted tree, and an accepted tree can be megabytes. */
export const ACCEPTANCE_REGISTRY_MAX = 4;

const HEX = /^[0-9a-f]+$/;

function randomHex(bytes) {
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === "function") {
    const buffer = new Uint8Array(bytes);
    source.getRandomValues(buffer);
    let out = "";
    for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
    return out;
  }
  // No CSPRNG: refuse rather than mint a guessable nonce. Every environment
  // this library supports has one, so this is a startup-class defect.
  throw new Error("acceptance: crypto.getRandomValues is required to mint an acceptance");
}

/**
 * Mint an acceptance record. Called ONLY in the policy Worker, immediately
 * after Lean accepted, with the checker identity that produced the verdict.
 */
export function mintAcceptance({ authority, checker, instanceId, sessionId, generation, requestId, treeNodes, treeUtf8Bytes }) {
  return Object.freeze({
    nonce: randomHex(ACCEPTANCE_NONCE_BYTES),
    authority,
    abi: checker.abi,
    checkerVersion: checker.checkerVersion,
    capabilityVersion: checker.capabilityVersion,
    profile: checker.profile,
    instanceId,
    sessionId,
    generation,
    requestId,
    treeNodes,
    treeUtf8Bytes,
  });
}

/** Shape check for a record that arrived over a message boundary. */
export function isAcceptanceToken(token) {
  if (token === null || typeof token !== "object" || Array.isArray(token)) return false;
  if (typeof token.nonce !== "string") return false;
  if (token.nonce.length !== ACCEPTANCE_NONCE_BYTES * 2 || !HEX.test(token.nonce)) return false;
  if (typeof token.authority !== "string" || token.authority.length === 0) return false;
  if (typeof token.checkerVersion !== "string" || token.checkerVersion.length === 0) return false;
  if (!Number.isInteger(token.abi) || token.abi < 0) return false;
  if (!Number.isInteger(token.capabilityVersion) || token.capabilityVersion < 0) return false;
  if (typeof token.profile !== "string" || token.profile.length === 0) return false;
  if (typeof token.instanceId !== "string" || typeof token.sessionId !== "string") return false;
  if (!Number.isInteger(token.generation) || token.generation < 0) return false;
  if (!Number.isInteger(token.requestId) || token.requestId < 0) return false;
  return true;
}

/**
 * A bounded, one-time registry of acceptances a session actually issued.
 *
 * Reference/test utility for the retired host-custody design, not a production
 * render path. A nonce can be claimed once; every
 * other outcome is a named refusal so a test can distinguish "you made this
 * up" from "you used it already".
 */
export function createAcceptanceRegistry({ max = ACCEPTANCE_REGISTRY_MAX, expect = {} } = {}) {
  /** @type {Map<string, {token: object, tree: object}>} */
  const entries = new Map();
  const stats = { recorded: 0, claimed: 0, evicted: 0, refused: 0 };

  function record(token, tree) {
    if (!isAcceptanceToken(token)) return { ok: false, reason: { code: "acceptance-malformed" } };
    if (entries.has(token.nonce)) return { ok: false, reason: { code: "acceptance-nonce-reused" } };
    // Oldest first: a Map preserves insertion order.
    while (entries.size >= max) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      stats.evicted += 1;
    }
    entries.set(token.nonce, { token, tree });
    stats.recorded += 1;
    return { ok: true };
  }

  /**
   * Claim a record and get back the exact tree that arrived with it.
   * @param {object} token
   * @param {object} [context] `{ generation }` to reject superseded records
   */
  function claim(token, context = {}) {
    if (!isAcceptanceToken(token)) {
      stats.refused += 1;
      return { ok: false, reason: { code: "acceptance-malformed" } };
    }
    const entry = entries.get(token.nonce);
    if (!entry) {
      // Either fabricated or already claimed. Both are refusals; they are not
      // distinguished here, because distinguishing them would tell a caller
      // whether a nonce it guessed ever existed.
      stats.refused += 1;
      return { ok: false, reason: { code: "acceptance-unknown-or-claimed" } };
    }
    entries.delete(token.nonce);
    const issued = entry.token;
    for (const field of ["authority", "checkerVersion", "capabilityVersion", "profile", "instanceId", "sessionId", "requestId", "generation"]) {
      if (token[field] !== issued[field]) {
        stats.refused += 1;
        return { ok: false, reason: { code: "acceptance-field-mismatch", detail: field } };
      }
    }
    if (expect.checkerVersion !== undefined && issued.checkerVersion !== expect.checkerVersion) {
      stats.refused += 1;
      return { ok: false, reason: { code: "acceptance-checker-version", detail: String(issued.checkerVersion).slice(0, 60) } };
    }
    if (expect.authority !== undefined && issued.authority !== expect.authority) {
      stats.refused += 1;
      return { ok: false, reason: { code: "acceptance-authority", detail: String(issued.authority).slice(0, 60) } };
    }
    if (context.generation !== undefined && issued.generation !== context.generation) {
      stats.refused += 1;
      return { ok: false, reason: { code: "acceptance-superseded" } };
    }
    stats.claimed += 1;
    return { ok: true, tree: entry.tree, token: issued };
  }

  /** Drop everything, or everything for a superseded generation. */
  function invalidate(predicate) {
    if (typeof predicate !== "function") {
      entries.clear();
      return;
    }
    for (const [nonce, entry] of [...entries.entries()]) {
      if (predicate(entry.token)) entries.delete(nonce);
    }
  }

  return {
    record,
    claim,
    invalidate,
    get size() { return entries.size; },
    get stats() { return { ...stats }; },
  };
}
