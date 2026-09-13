// Acceptance records: the binding between a Lean verdict and a frame commit.
//
// WHAT PROBLEM THIS SOLVES
//
// Before this, the host received an accepted tree from the policy Worker and
// then called `frame.render(tree)` with whatever object it happened to be
// holding. The frame re-checked the tree with the JavaScript predicate, so an
// obviously-unsafe tree was refused -- but nothing tied the commit to the
// acceptance that authorized it. A caller could render a *different* validated
// tree, an older one, or the same one twice, and the frame could not tell.
//
// So the policy Worker now mints a one-time acceptance record for each
// accepted document. The record's nonce is generated INSIDE the Worker, next
// to the Lean verdict. The host keeps a bounded registry mapping each nonce to
// the exact tree that arrived with it, and the frame's render path takes a
// record, not a tree: it claims the nonce, gets the stored tree back, and
// renders THAT. The host has no way to put a different tree in front of the
// frame, because it never supplies one.
//
// Consequences that the negative controls check:
//   * a fabricated record has an unknown nonce               -> refused
//   * a replayed record has a consumed nonce                 -> refused
//   * a record from a superseded generation                  -> refused
//   * a record whose checker identity is not this build's    -> refused
//
// WHAT THIS IS NOT
//
// It is not a cryptographic authentication of the tree, and it is not a
// defence against a compromised host: the host is inside the trusted computing
// base, it holds the registry, and per the plan the attacker model is
// generated content, not the embedding application. What it provides is that
// there is no *code path* from a JavaScript-only decision to a frame commit,
// and that provenance, staleness and replay are detected rather than assumed.
// The private MessagePort in Phase 5 replaces the host's custody of the tree
// with delivery straight from the Worker; this is the ownership discipline
// that makes that change a narrowing rather than a rewrite.

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
 * `record` is called by the policy client when an accepted reply arrives.
 * `claim` is called by the render path. A nonce can be claimed once; every
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
