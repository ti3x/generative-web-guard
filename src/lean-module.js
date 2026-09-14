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
// Embedding and compression measurements are recorded in docs/phase6-results.md.
// The default encoding and optional gzip prototype are selected at build time.
// Decoding is bounded, async, and cached; failure never installs an authority.
//
// This module is imported by src/policy-worker.js, so everything it pulls in
// is bundled into the Worker payload. It must never gain a runtime import.

import createGuardChecker from "../lean/wasm/dist/guard.mjs";
import wasm from "../dist/lean-checker-wasm.js";
import { decodeCheckerAsset } from "./checker-asset.js";

/** Identity of the checker artifact from the build. */
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
  if (decoded === null) decoded = decodeCheckerAsset(wasm);
  return decoded;
}

/** The Emscripten factory for the checker. */
export { createGuardChecker as createModule };
