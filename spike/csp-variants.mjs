// CSP header variants applied to the host page. {SCRIPT_HASH}, {CSS_HASH} and
// {CDN} are substituted by spike/serve.mjs. Quote these strings verbatim in the
// report: they are the exact policies that were tested.
export const DEMO_CURRENT =
  "default-src 'self'; script-src 'self' 'sha256-{SCRIPT_HASH}'; style-src 'self' 'sha256-{CSS_HASH}'; " +
  "worker-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'";

export const Q1_VARIANTS = {
  "no-csp": "",
  "demo-current": DEMO_CURRENT,
  "demo-without-frame-script-hash":
    "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self'; " +
    "connect-src 'none'; object-src 'none'; base-uri 'none'",
  "demo-without-frame-style-hash":
    "default-src 'self'; script-src 'self' 'sha256-{SCRIPT_HASH}'; style-src 'self'; worker-src 'self'; " +
    "connect-src 'none'; object-src 'none'; base-uri 'none'",
  "frame-src-none":
    "default-src 'self'; script-src 'self' 'sha256-{SCRIPT_HASH}'; style-src 'self' 'sha256-{CSS_HASH}'; " +
    "worker-src 'self'; frame-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'",
};

export const Q2_CANDIDATE =
  "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
  "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; connect-src {CDN}; " +
  "frame-src about: blob:; object-src 'none'; base-uri 'none'";

export const Q2_VARIANTS = {
  "no-csp": "",
  "demo-current": DEMO_CURRENT,
  "demo-plus-cdn-script-src":
    "default-src 'self'; script-src 'self' {CDN}; style-src 'self'; worker-src 'self'; " +
    "connect-src 'none'; object-src 'none'; base-uri 'none'",
  "cdn-script-src-plus-blob-worker-src":
    "default-src 'self'; script-src 'self' {CDN}; style-src 'self'; worker-src 'self' blob:; " +
    "connect-src 'none'; object-src 'none'; base-uri 'none'",
  "cdn-script-src-blob-worker-plus-wasm":
    "default-src 'self'; script-src 'self' {CDN} 'wasm-unsafe-eval'; style-src 'self'; " +
    "worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'",
  "candidate-production": Q2_CANDIDATE,
  "no-worker-src-script-src-fallback":
    "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval'; style-src 'self'; " +
    "connect-src {CDN}; object-src 'none'; base-uri 'none'",
  "child-src-fallback":
    "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval'; child-src 'self' blob:; " +
    "style-src 'self'; connect-src {CDN}; object-src 'none'; base-uri 'none'",
  "default-src-only-fallback":
    "default-src 'self' {CDN} blob: 'wasm-unsafe-eval'",
  "candidate-production-plus-blob-script-src":
    "default-src 'none'; script-src 'self' {CDN} blob: 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self' blob:; connect-src {CDN}; " +
    "frame-src about: blob:; object-src 'none'; base-uri 'none'",
  "unsafe-eval-instead-of-wasm-unsafe-eval":
    "default-src 'none'; script-src 'self' {CDN} 'unsafe-eval'; style-src 'self'; " +
    "worker-src 'self' blob:; connect-src {CDN}; object-src 'none'; base-uri 'none'",
};

// End-to-end topology variants. `candidate-production` allows blob: workers;
// `candidate-production-no-blob` keeps worker-src 'self' only, which forces the
// same-origin shim approach.
export const Q3_VARIANTS = {
  "candidate-production": Q2_CANDIDATE,
  "candidate-production-no-blob":
    "default-src 'none'; script-src 'self' {CDN} 'wasm-unsafe-eval' 'sha256-{SCRIPT_HASH}'; " +
    "style-src 'self' 'sha256-{CSS_HASH}'; worker-src 'self'; connect-src {CDN}; " +
    "frame-src about:; object-src 'none'; base-uri 'none'",
  "demo-current": DEMO_CURRENT,
};
