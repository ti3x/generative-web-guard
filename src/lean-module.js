// The Lean/Wasm checker as a self-contained module.
//
// WHY THE BINARY IS EMBEDDED AND NOT FETCHED
//
// The policy Worker payload must be self-contained: a cross-origin Worker URL
// fails on every engine under every CSP, and a static top-level import inside
// a module Worker fails with no violation report. `scripts/build.mjs` and
// `scripts/check-cdn.mjs` both assert that the shipped payloads contain no
// import at all. So the checker bytes have to travel inside the bundle.
//
// The alternative -- shipping `guard.wasm` as a separate asset and fetching it
// -- would require widening the host policy to `connect-src <cdn>`. Profile A
// deliberately ships `connect-src 'none'`, taking the report's "omit it if
// every binary is embedded" branch, and embedding keeps that. It also makes
// "the deployed bytes are the bytes that were built and tested" trivially
// true: there is one artifact to hash, not an artifact plus a fetch.
//
// The cost is measured, not guessed (see README's distribution section):
// base64 costs +33% on a 1.71 MB binary, so the policy Worker payload grows
// from ~210 KB to ~2.5 MB, and ~57 KB to ~545 KB gzipped. Phase 6 owns
// reducing that -- it is the phase that bundles only the candidate checker and
// records before/after compressed sizes -- and a gzip-then-base64 embedding
// (measured at 344 KB / 459 KB base64) is the obvious next step there. It is
// not done here because it would add a `DecompressionStream` dependency to the
// trusted startup path in a phase whose job is correctness.
//
// This module is imported by src/policy-worker.js, so everything it pulls in
// is bundled into the Worker payload. It must never gain a runtime import.

import createGuardChecker from "../lean/wasm/dist/guard.mjs";
import wasm from "../dist/lean-checker-wasm.js";

/** `{ base64, bytes, sha256 }` of the checker, from the build. */
export const checkerAsset = Object.freeze({
  bytes: wasm.bytes,
  sha256: wasm.sha256,
  builtFrom: wasm.builtFrom,
});

let decoded = null;

/**
 * The checker bytes. Decoded once and cached: a second instance in the same
 * realm reuses the array rather than decoding 2.3 MB of base64 again.
 */
export function checkerBinary() {
  if (decoded === null) {
    const text = atob(wasm.base64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    if (out.byteLength !== wasm.bytes) {
      // The build records the length; a mismatch means the embedded string was
      // truncated or re-encoded somewhere in the pipeline.
      throw new Error(`lean-module: decoded ${out.byteLength} bytes, build recorded ${wasm.bytes}`);
    }
    decoded = out;
  }
  return decoded;
}

/** The Emscripten factory for the checker. */
export { createGuardChecker as createModule };
