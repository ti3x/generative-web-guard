import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const coreUrl = new URL("../cdn/generative-web-guard.js", import.meta.url);
const fullUrl = new URL("../cdn/generative-web-guard.full.min.js", import.meta.url);
const lintUrl = new URL("../cdn/generative-web-guard.lint.js", import.meta.url);
const core = await import(`${coreUrl.href}?check=${Date.now()}`);
const full = await import(`${fullUrl.href}?check=${Date.now()}`);
const lint = await import(`${lintUrl.href}?check=${Date.now()}`);

for (const name of [
  "createGuardFrame", "manifest",
  "preprocessHtml", "PREPROCESS_LIMITS", "createPolicySession", "POLICY_PROTOCOL_VERSION",
  // Startup diagnostics: per-stage codes, budgets and the blob: Worker helper.
  "STARTUP_STAGES", "STARTUP_TIMEOUTS", "STARTUP_ERRORS", "STARTUP_WARNINGS",
  "StartupError", "createBlobWorker",
  // The Lean/Wasm authority contract and the acceptance binding.
  "LEAN_ABI_VERSION", "LEAN_CHECKER_VERSION", "LEAN_PROFILE", "LEAN_AUTHORITY",
]) {
  assert.ok(name in core, `CDN core export missing: ${name}`);
}
for (const name of [
  "createGuard",
  "createGuardWorker", "createGuardRuntime", "createGuardPolicyWorker", "createGuardPolicySession",
  "createGuardBlobWorker", "embeddedWorkerBytes",
]) {
  assert.ok(name in full, `CDN full export missing: ${name}`);
}

// Every startup code names a stage and carries a hint. A code with no hint is
// not actionable, which is the entire point of having per-stage codes.
for (const [code, entry] of Object.entries(core.STARTUP_ERRORS)) {
  assert.ok(Object.values(core.STARTUP_STAGES).includes(entry.stage), `startup code ${code} has an unknown stage: ${entry.stage}`);
  assert.ok(entry.hint.length > 40, `startup code ${code} has no usable hint`);
}
for (const required of [
  "csp-worker-blob", "csp-wasm-unsafe-eval", "csp-cdn-script-src", "csp-connect-src",
  "frame-bootstrap-timeout", "channel-handshake-timeout", "wasm-init-timeout",
]) {
  assert.ok(required in core.STARTUP_ERRORS, `startup code missing: ${required}`);
}
// The frame-bootstrap case has no violation report on any engine, so its
// message must name both hashes and must not assert a cause.
assert.match(core.STARTUP_ERRORS["frame-bootstrap-timeout"].hint, /script-src/);
assert.match(core.STARTUP_ERRORS["frame-bootstrap-timeout"].hint, /style-src/);
assert.match(core.STARTUP_ERRORS["frame-bootstrap-timeout"].hint, /NO securitypolicyviolation/);
// 'wasm-unsafe-eval' is the required token; 'unsafe-eval' must never be
// offered as a remedy anywhere in the shipped diagnostics.
assert.match(core.STARTUP_ERRORS["csp-wasm-unsafe-eval"].hint, /'wasm-unsafe-eval'/);
for (const [code, entry] of Object.entries(core.STARTUP_ERRORS)) {
  assert.ok(!/(^|[^-])'unsafe-eval'(?!:)/.test(entry.hint.replace(/Do NOT use 'unsafe-eval'[^.]*\./, "")),
    `startup hint for ${code} appears to recommend 'unsafe-eval'`);
}
assert.ok(full.embeddedWorkerBytes.quickjs > 100_000, "full bundle does not embed the QuickJS worker payload");
assert.ok(full.embeddedWorkerBytes.policy > 10_000, "full bundle does not embed the policy worker payload");
// The optional linter moved to its own entry point (BREAKING: gateProgram is
// no longer exported by the default bundle). It is diagnostic, never
// authorization, and it is the only reason Acorn would be bundled.
assert.ok("gateProgram" in lint, "CDN lint export missing: gateProgram");
assert.ok(!("gateProgram" in core), "gateProgram must not be in the default entry point");
assert.equal(lint.gateProgram("const initialState=1;\nfunction update(s){return s}\nfunction view(){return ''}").authorization, "none");

for (const name of ["guardHtml", "checkTree", "isValidated", "createAcceptanceRegistry"]) {
  assert.ok(!(name in core) && !(name in full), `removed acceptance export still shipped: ${name}`);
}

// R3: bounded preprocessing rather than a stack overflow, on the shipped bytes.
const deep = core.preprocessHtml("<div>".repeat(5000) + "x" + "</div>".repeat(5000));
assert.equal(deep.status, "rejected");
assert.equal(deep.reason.code, "raw-depth-exceeded");
assert.equal(deep.reason.limit, "maxRawDepth");

for (const file of [
  "generative-web-guard.js",
  "generative-web-guard.min.js",
  "generative-web-guard.full.min.js",
  "generative-web-guard.lint.js",
  "worker.min.js",
  "policy-worker.min.js",
]) {
  const contents = await readFile(new URL(`../cdn/${file}`, import.meta.url), "utf8");
  assert.ok(contents.length > 100, `CDN artifact is unexpectedly empty: ${file}`);
}

// Acorn must not be in the default runtime dependency path.
const coreText = await readFile(coreUrl, "utf8");
const minText = await readFile(new URL("../cdn/generative-web-guard.min.js", import.meta.url), "utf8");
for (const [name, text] of [["generative-web-guard.js", coreText], ["generative-web-guard.min.js", minText]]) {
  assert.ok(!text.includes("ecmaVersion"), `${name} still bundles the Acorn parser`);
}
// The policy Worker must not be able to execute generated JavaScript.
const policyText = await readFile(new URL("../cdn/policy-worker.min.js", import.meta.url), "utf8");
assert.ok(!policyText.includes("non-canonical-output"), "production Worker still bundles JS replay acceptance");
assert.ok(!policyText.includes("authority-mismatch"), "production Worker still bundles JS/Lean acceptance comparison");
for (const token of ["new Function", "quickjs"]) {
  assert.ok(!policyText.includes(token), `policy worker bundle references ${token}`);
}
// `importScripts` may only be MENTIONED, by the Emscripten glue's environment
// detection (`typeof importScripts == "function"`). A CALL would be a way to
// load external code into the Worker, and that is what must not exist. The
// self-containment block below asserts the no-call form for both payloads.
assert.ok(!/\bimportScripts\s*\(/.test(policyText), "policy worker bundle CALLS importScripts");
for (const mention of policyText.match(/.{0,14}importScripts.{0,2}/g) ?? []) {
  assert.match(mention, /typeof\s?importScripts/, `unexpected importScripts reference in the policy worker: ${mention}`);
}
// `eval` and `Function` as constructors must not appear at all.
assert.ok(!/\beval\s*\(/.test(policyText), "policy worker bundle calls eval");

// ---------------------------------------------------------------------------
// The Lean/Wasm checker is EMBEDDED, not fetched.
//
// A fetched .wasm would need `connect-src <cdn>` in the host policy; Profile A
// ships `connect-src 'none'`. Embedding is what keeps that, and it is what
// makes "the deployed bytes are the bytes that were built" one artifact to
// hash. `scripts/browser-check.mjs` measures the other half of this -- that no
// request for guard.wasm is ever made on any engine.
const assetManifest = JSON.parse(await readFile(new URL("../cdn/asset-manifest.json", import.meta.url), "utf8"));
assert.equal(assetManifest.manifestVersion, 1);
assert.equal(assetManifest.checker.fetched, false, "the manifest claims the checker is fetched");
assert.ok(assetManifest.checker.wasmBytes > 500_000, "implausibly small checker binary");
assert.match(assetManifest.checker.wasmSha256, /^[0-9a-f]{64}$/);
// The wording discipline the plan asks for: a hash binds contents and detects
// mismatch; it does not prove provenance. If that sentence is ever dropped, the
// manifest starts reading like an attestation.
assert.match(assetManifest.note, /do not prove provenance/i);
assert.match(assetManifest.note, /bind build CONTENTS|bind.*contents/i);

// Every artifact the manifest names must still hash to what it records. This is
// the stale-artifact check: a rebuilt checker with a forgotten bundle, or a
// rebuilt bundle against an old checker, fails here.
//
// `lean/wasm/dist/` is a local build output and is not committed, so those
// entries are verified only when present. The checker's own bytes are checked
// unconditionally below, from the committed payload that embeds them, which is
// the stronger check anyway: it hashes what actually ships.
let verified = 0;
let skipped = 0;
for (const [name, entry] of Object.entries(assetManifest.assets)) {
  let bytes;
  try {
    bytes = await readFile(new URL(`../${name}`, import.meta.url));
  } catch (error) {
    if (name.startsWith("lean/wasm/dist/")) { skipped += 1; continue; }
    throw error;
  }
  assert.equal(bytes.byteLength, entry.bytes, `${name}: size differs from the manifest; rebuild with npm run build`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${name}: sha256 differs from the manifest; rebuild with npm run build`);
  verified += 1;
}
for (const required of [
  "cdn/policy-worker.min.js", "cdn/generative-web-guard.full.min.js", "lean/wasm/dist/guard.wasm",
]) {
  assert.ok(required in assetManifest.assets, `asset manifest does not cover ${required}`);
}

// THE CHECKER THAT ACTUALLY SHIPS.
//
// Pull the embedded base64 out of each committed payload that claims to carry
// it, decode it, and require it to be exactly the binary the manifest records
// -- length, sha256, and the WebAssembly magic. This works on a fresh checkout
// with no Lean toolchain, and it is what makes "the deployed bytes are the
// bytes that were built" checkable rather than asserted.
for (const name of assetManifest.checker.embeddedIn) {
  const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  // More than one base64 WebAssembly module can appear in a payload: the full
  // bundle also carries QuickJS's own embedded binary, which likewise starts
  // with the "\0asm" magic. Select by the recorded length and then prove the
  // choice by hash, so picking the wrong run cannot pass.
  const runs = text.match(/(?:AGFzbQ|H4sI)[A-Za-z0-9+/]+={0,2}/g) ?? [];
  assert.ok(runs.length > 0, `${name} embeds no base64 WebAssembly module at all`);
  const candidates = runs.filter((run) => run.length === assetManifest.checker.base64Chars);
  assert.equal(
    candidates.length, 1,
    `${name}: expected exactly one embedded module of ${assetManifest.checker.base64Chars} base64 chars, found ${candidates.length} (run lengths: ${runs.map((r) => r.length).join(", ")})`,
  );
  const encoded = Buffer.from(candidates[0], "base64");
  const embedded = assetManifest.checker.encoding === "gzip-base64" ? gunzipSync(encoded) : encoded;
  assert.equal(embedded.byteLength, assetManifest.checker.wasmBytes, `${name}: embedded checker is ${embedded.byteLength} bytes, manifest says ${assetManifest.checker.wasmBytes}`);
  assert.equal(createHash("sha256").update(embedded).digest("hex"), assetManifest.checker.wasmSha256, `${name}: embedded checker sha256 differs from the manifest`);
  assert.deepEqual([...embedded.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], `${name}: embedded checker is not a WebAssembly module`);
}

// The lower-level frame factory creates an inert port-only endpoint.
const frameDom = new JSDOM("<div id=c></div>");
const portFrame = core.createGuardFrame({ container: frameDom.window.document.getElementById("c") });
assert.equal(portFrame.render, undefined);
assert.equal(portFrame.clear, undefined);
assert.equal(typeof portFrame.attachPort, "function");
portFrame.destroy(); frameDom.window.close();
for (const [label, mod] of [["core", core], ["full", full]]) {
  assert.ok(!("createSandboxFrame" in mod), `${label} bundle exports createSandboxFrame, source-only factory`);
  assert.ok(!("createPolicyCore" in mod), `${label} bundle exports createPolicyCore, whose options can install a checker`);
}

// ---------------------------------------------------------------------------
// Worker payloads must be self-contained, on the shipped bytes.
//
// A cross-origin Worker URL fails on every engine under every CSP, so the
// payload cannot be fetched. And a static top-level `import` inside a module
// Worker is checked against `worker-src` rather than `script-src` and fails
// with an opaque `error` event and NO violation report on Chromium, Firefox or
// WebKit -- an unexplained dead Worker. Assert against both here as well as in
// scripts/build.mjs, because this file checks the committed artifacts.
const workerText = await readFile(new URL("../cdn/worker.min.js", import.meta.url), "utf8");
for (const [name, text] of [["worker.min.js", workerText], ["policy-worker.min.js", policyText]]) {
  assert.ok(!/(^|[\s;}])import\s*[("'`{*]/.test(text), `${name} contains an import; worker payloads must be self-contained`);
  assert.ok(!/\bfrom\s*["'`]/.test(text), `${name} contains a module import; worker payloads must be self-contained`);
  assert.ok(!/\bimportScripts\s*\(/.test(text), `${name} calls importScripts; worker payloads must be self-contained`);
}
// The full bundle must carry both payloads inline, so no Worker is ever
// constructed from a URL on the library's own origin or the CDN's.
const fullText = await readFile(fullUrl, "utf8");
assert.ok(!/new Worker\(\s*["'`]/.test(fullText), "full bundle constructs a Worker from a literal URL instead of a blob:");
assert.ok(fullText.includes("createObjectURL"), "full bundle does not create its Workers from blob: URLs");

console.log(`CDN artifacts: imports, public exports, startup codes, self-contained worker payloads, embedded Lean checker verified by hash in ${assetManifest.checker.embeddedIn.length} payloads (${(assetManifest.checker.wasmBytes / 1024).toFixed(0)} KiB, sha256 ${assetManifest.checker.wasmSha256.slice(0, 12)}), ${verified} manifest hashes checked${skipped ? ` (${skipped} local build output(s) absent)` : ""}, port-only frame, linter separation, and bounded preprocessing passed`);
