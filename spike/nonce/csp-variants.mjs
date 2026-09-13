// Host-document CSP header variants for the nonce / 'strict-dynamic' spike.
// {SCRIPT_HASH}, {CSS_HASH}, {CDN} and {NONCE} are substituted by serve.mjs.
// Quote these strings verbatim in the report: they are the exact policies
// measured.

const TAIL = "object-src 'none'; base-uri 'none'; form-action 'none'";

// The shipped Profile A (docs/csp.md), as a control: host-source allowlist, no
// nonce, no 'strict-dynamic'.
export const PROFILE_A =
  "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
  "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; connect-src {CDN}; " + TAIL;

// The candidate nonce profile: Profile A with the host-source expressions in
// script-src replaced by a nonce plus 'strict-dynamic', keeping the hash, the
// wasm token, worker-src and connect-src.
export const NONCE_SD_CANDIDATE =
  "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
  "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; connect-src {CDN}; " + TAIL;

// What Google's CSP Evaluator recommends and what Rails/Django/Next-style
// generators emit: a nonce, 'strict-dynamic', a scheme allowlist and
// 'unsafe-inline' for backwards compatibility, no default-src, no worker-src,
// no hashes. http: is included because this harness runs over http.
export const GOOGLE_RECOMMENDED =
  "script-src 'nonce-{NONCE}' 'strict-dynamic' https: http: 'unsafe-inline'; object-src 'none'; base-uri 'none'";

// ---------------------------------------------------------------------------
// n1: script loading. Frame and Workers are irrelevant here.
export const N1_VARIANTS = {
  "profile-a-control": PROFILE_A,
  "nonce-sd-bare":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic'; style-src 'self'; " + TAIL,
  "nonce-sd-with-cdn-and-self":
    "default-src 'none'; script-src 'self' {CDN} 'nonce-{NONCE}' 'strict-dynamic'; style-src 'self'; " + TAIL,
  "nonce-only-with-cdn-and-self":
    "default-src 'none'; script-src 'self' {CDN} 'nonce-{NONCE}'; style-src 'self'; " + TAIL,
  "nonce-only-bare":
    "default-src 'none'; script-src 'nonce-{NONCE}'; style-src 'self'; " + TAIL,
  "google-recommended": GOOGLE_RECOMMENDED,
  "nonce-sd-candidate": NONCE_SD_CANDIDATE,
};

// Variants that are additionally run with the host bootstrap script's nonce
// attribute REMOVED (?hostNonce=0), i.e. the markup Profile A documents today.
export const N1_NO_HOST_NONCE = ["profile-a-control", "nonce-sd-with-cdn-and-self"];

// ---------------------------------------------------------------------------
// n2: blob: Workers, the worker-source fallback chain, and Wasm.
export const N2_VARIANTS = {
  "profile-a-control": PROFILE_A,
  "nonce-sd-candidate": NONCE_SD_CANDIDATE,
  // Q6: is 'wasm-unsafe-eval' still effective next to 'strict-dynamic'?
  "nonce-sd-no-wasm-token":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; connect-src {CDN}; " + TAIL,
  // Q4: is a worker source directive containing blob: still required?
  "nonce-sd-worker-src-self-only":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'; " +
    "style-src 'self'; worker-src 'self'; connect-src {CDN}; " + TAIL,
  // Does 'strict-dynamic' in worker-src void the blob: scheme-source there?
  "nonce-sd-worker-src-strict-dynamic":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'; " +
    "style-src 'self'; worker-src 'nonce-{NONCE}' 'strict-dynamic' blob:; connect-src {CDN}; " + TAIL,
  // Fallback chain with 'strict-dynamic' present in script-src and blob: only
  // in script-src / child-src / default-src.
  "nonce-sd-no-worker-src-blob-in-script-src":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' blob: 'wasm-unsafe-eval'; " +
    "style-src 'self'; connect-src {CDN}; " + TAIL,
  "nonce-sd-child-src-blob":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'; " +
    "child-src 'self' blob:; style-src 'self'; connect-src {CDN}; " + TAIL,
  "nonce-sd-default-src-blob":
    "default-src blob:; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'; " +
    "style-src 'self'; connect-src {CDN}; " + TAIL,
  // The real-world policy: no worker-src, no child-src, NO default-src at all.
  "google-recommended": GOOGLE_RECOMMENDED,
  // Control for the Chromium "throws synchronously" claim in docs/csp.md and
  // src/startup.js: same missing blob:, but under the shipped Profile A shape
  // with no nonce and no 'strict-dynamic'.
  "profile-a-worker-src-self-only":
    "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self'; connect-src {CDN}; " + TAIL,
  "nonce-only-worker-blob":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'wasm-unsafe-eval'; style-src 'self'; " +
    "worker-src 'self' blob:; connect-src {CDN}; " + TAIL,
};

// ---------------------------------------------------------------------------
// n3: the hash-pinned srcdoc frame.
export const N3_VARIANTS = {
  "profile-a-control": PROFILE_A,
  "nonce-sd-candidate": NONCE_SD_CANDIDATE,
  "nonce-sd-no-frame-script-hash":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; " + TAIL,
  "nonce-sd-no-frame-style-hash":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self'; worker-src 'self' blob:; " + TAIL,
  "nonce-only-with-hashes":
    "default-src 'none'; script-src 'nonce-{NONCE}' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; " + TAIL,
  "google-recommended": GOOGLE_RECOMMENDED,
};

// Frame variants additionally run with ?frameNonce=1, which puts the page's
// nonce on the frame's inline script tag and in the frame's own meta policy.
// This is a CONTINGENCY probe: the library has no nonce today.
export const N3_FRAME_NONCE = ["nonce-sd-no-frame-script-hash", "google-recommended", "nonce-sd-candidate"];

// ---------------------------------------------------------------------------
// n4: end to end.
export const N4_VARIANTS = {
  "profile-a-control": PROFILE_A,
  "nonce-sd-candidate": NONCE_SD_CANDIDATE,
  "google-recommended": GOOGLE_RECOMMENDED,
};
