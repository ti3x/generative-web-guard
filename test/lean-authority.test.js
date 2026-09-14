// NEGATIVE INTEGRATION CONTROLS for the Lean/Wasm acceptance authority, plus
// the ABI and decoder hardening checks.
//
// WHY THIS FILE EXISTS
//
// "Lean is the authority" is a claim about what happens when Lean says no, or
// cannot answer at all. Asserting it from the happy path proves nothing: a
// build that ignored the verdict entirely would pass every positive test. So
// each control below breaks the authority in one specific way and demands that
// nothing renders and that the failure is bounded:
//
//   1. Lean rejects a benign candidate
//   2. the checker is missing
//   3. the module is corrupt, empty, or has the wrong exports
//   4. the checker never finishes starting (stalled wasm-init)
//   5. a reply is spoofed -- wrong authority, fabricated or absent acceptance
//   6. a reply is replayed -- the same acceptance used twice
//   7. the JS candidate builder is forced to emit a forbidden tree
//   8. a message tries to install or disable a checker
//   9. the module traps and the instance is poisoned
//
// Every injection point is an in-process constructor argument. None is
// reachable from a message: `handlePolicyRequest` reads only `kind`, `html`,
// `classes` and the identity fields, and control 8 demonstrates that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createPolicyCore, handlePolicyRequest, LEAN_AUTHORITY } from "../src/policy-core.js";
import { createPolicySession } from "../src/policy-client.js";
import { createLeanChecker } from "../src/lean-checker.js";
import { createSandboxFrame } from "../src/host.js";
import { setClassAllowlist } from "../src/policy.js";
import {
  createAcceptanceRegistry,
  isAcceptanceToken,
  mintAcceptance,
  ACCEPTANCE_NONCE_BYTES,
} from "../src/acceptance.js";
import {
  LEAN_ABI_VERSION,
  LEAN_CHECKER_VERSION,
  LEAN_MIN_LIMITS,
  LEAN_PROFILE,
  checkRequest,
  configureRequest,
  readCheckResponse,
  shimCode,
} from "../src/lean-abi.js";
import { POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, PREPROCESS_LIMITS } from "../src/policy-protocol.js";
import {
  CLASSES,
  EXPECTED_IDENTITY,
  corruptChecker,
  leanSkip,
  poisonedChecker,
  rawCreateModule,
  rawWasmBinary,
  realChecker,
  rejectingChecker,
  stubChecker,
} from "./lean-support.js";

const skip = leanSkip();
setClassAllowlist(CLASSES);

const el = (children, attrs = [], tag = "div", ns = "html") => ({ kind: "el", ns, tag, attrs, children });
const txt = (text) => ({ kind: "text", text });
const doc = (...children) => ({ kind: "root", children });
const BENIGN = `<p class="card">benign</p>`;

function envelope(fields = {}) {
  return {
    protocol: POLICY_PROTOCOL_VERSION,
    kind: POLICY_MESSAGE.preprocess,
    instanceId: "i",
    sessionId: "s",
    generation: 0,
    requestId: 1,
    html: BENIGN,
    ...fields,
  };
}

// A Worker stand-in, as in test/policy-worker.test.js but with the startup
// messages under test control.
function fakeWorker({ core = null, ready = true, checkerReady = true, identity = null, failed = null, mangle = null, hang = false } = {}) {
  const listeners = { message: new Set(), error: new Set() };
  const worker = {
    posted: [],
    terminated: false,
    addEventListener(type, fn) { listeners[type]?.add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    terminate() { worker.terminated = true; listeners.message.clear(); },
    postMessage(request) {
      worker.posted.push(request);
      if (hang || core === null) return;
      setTimeout(() => {
        if (worker.terminated) return;
        let reply = handlePolicyRequest(core, request);
        if (mangle) reply = mangle(reply);
        for (const fn of [...listeners.message]) fn({ data: reply });
      }, 0);
    },
  };
  setTimeout(() => {
    if (worker.terminated) return;
    const emit = (data) => { for (const fn of [...listeners.message]) fn({ data }); };
    if (ready) emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.ready });
    if (failed) emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.failed, reason: failed });
    else if (checkerReady) emit({ protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.checkerReady, checker: identity ?? EXPECTED_IDENTITY });
  }, 0);
  return worker;
}

function session(workerOptions = {}, sessionOptions = {}) {
  const worker = fakeWorker(workerOptions);
  const client = createPolicySession({
    createWorker: () => worker,
    classes: CLASSES,
    timeouts: { startupMs: 80, requestMs: 80, wasmInitMs: 40, channelHandshakeMs: 40 },
    ...sessionOptions,
  });
  return { worker, client };
}

// ---------------------------------------------------------------------------
// The authority itself: identity, sealing, and what the ABI will accept
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] eager policy startup reuses its promise before and after readiness", async () => {
  const { client } = session();
  try {
    const first = client.start();
    assert.equal(client.start(), first, "concurrent starts share one startup");
    const identity = await first;
    assert.equal(client.start(), first, "a ready Worker must not get an unsettled replacement promise");
    assert.deepEqual(await client.start(), identity);
    assert.equal(client.stats.sessions, 1);
  } finally {
    client.dispose();
  }
});

test("[R-CHECK-ACCEPTANCE] the shipped module reports this build's checker identity and the frontend's bounds", { skip }, async () => {
  const checker = await realChecker();
  assert.equal(checker.identity.abi, LEAN_ABI_VERSION);
  assert.equal(checker.identity.checkerVersion, LEAN_CHECKER_VERSION);
  assert.equal(checker.identity.capabilityVersion, EXPECTED_IDENTITY.capabilityVersion);
  assert.equal(checker.identity.profile, LEAN_PROFILE);
  assert.equal(checker.poisoned, false);
  // The module's compiled-in decoder bounds must be no TIGHTER than the
  // frontend's, so the decoder cannot refuse a document preprocessing already
  // accepted. The glue refuses to start otherwise, so reaching here proves the
  // comparison ran; these assertions pin the direction of the relation.
  for (const [key, minimum] of Object.entries(LEAN_MIN_LIMITS)) {
    assert.ok(checker.identity.limits[key] >= minimum, `${key}: module ${checker.identity.limits[key]} < frontend ${minimum}`);
  }
  assert.equal(LEAN_MIN_LIMITS.maxRawNodes, PREPROCESS_LIMITS.maxRawNodes);
  // maxRawNodes is deliberately looser in the module: the frontend's is a
  // capacity bound equal to the policy's maxNodes (the per-sibling recursion is
  // bounded by its maxRawPathNodes, which the module does not report), and the
  // module's is a backstop for a direct caller.
  assert.ok(checker.identity.limits.maxRawNodes > PREPROCESS_LIMITS.maxRawNodes,
    "the module's node backstop should be looser than the frontend's measured bound");
});

test("[R-CHECK-ACCEPTANCE] the instance's configuration is sealed: the same configuration is idempotent, a different one is refused", { skip }, async () => {
  const checker = await realChecker({ fresh: true, classes: ["card"], stylesheetHash: "seal-test" });
  // Identical bytes: accepted, so a retry during startup is harmless.
  assert.equal(checker.tryReconfigure(["card"], "seal-test").status, "configured");
  // A different class list, a different stylesheet identity, or both: refused
  // by the shim, which owns the seal.
  for (const [classes, hash] of [[["card", "evil"], "seal-test"], [["card"], "other"], [[], "other"]]) {
    const result = checker.tryReconfigure(classes, hash);
    assert.equal(result.status, "error", JSON.stringify({ classes, hash }));
    assert.equal(result.reason.code, shimCode(-4));
  }
  // And the sealed list is still the one that decides.
  const verdict = checker.check("r", doc(el([txt("x")], [["class", "card evil"]], "p")));
  assert.equal(verdict.status, "rejected");
  assert.equal(verdict.tree, undefined);
  assert.equal(checker.check("allowed", doc(el([], [["class", "card"]], "p"))).status, "accepted");
});

test("[R-CHECK-ACCEPTANCE] a check request carries only the document, so nothing on the hot path can set policy", () => {
  const request = JSON.parse(checkRequest("r1", doc()));
  assert.deepEqual(Object.keys(request).sort(), ["abi", "document", "op", "requestId"]);
  assert.equal(request.abi, LEAN_ABI_VERSION);
  assert.equal(request.op, "check");
  // The configure request is the only one that carries policy configuration,
  // and its field order is fixed so the sealed bytes are deterministic.
  const config = JSON.parse(configureRequest({ classes: ["b", "a"], stylesheetHash: "h" }));
  assert.deepEqual(Object.keys(config), ["abi", "op", "profile", "classes", "stylesheetHash"]);
  assert.equal(config.profile, LEAN_PROFILE);
  assert.deepEqual(config.classes, ["b", "a"]);
  // Bounded and validated before it goes anywhere.
  assert.throws(() => configureRequest({ classes: ["a", "a"], stylesheetHash: "h" }), /duplicate class/);
  assert.throws(() => configureRequest({ classes: ["a"], stylesheetHash: "" }), /stylesheetHash/);
  assert.throws(() => configureRequest({ classes: "a", stylesheetHash: "h" }), /must be an array/);
  assert.throws(() => checkRequest("", doc()), /requestId/);
  assert.throws(() => checkRequest("x".repeat(200), doc()), /requestId/);
});

// ---------------------------------------------------------------------------
// Decoder and conversion hardening, through the shipped module
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] a canonical document round trips through the ABI exactly and with no changes", { skip }, async () => {
  const checker = await realChecker();
  const canonical = doc(el([txt("hello")], [["class", "card"]], "p"));
  const first = checker.check("r1", canonical);
  assert.equal(first.status, "accepted");
  assert.deepEqual(first.tree, canonical);
  assert.equal("changes" in first, false);
  // And it is a fixed point: feeding the accepted tree back changes nothing.
  const second = checker.check("r2", first.tree);
  assert.equal(second.status, "accepted");
  assert.deepEqual(second.tree, first.tree);
  assert.equal("changes" in second, false);
  assert.deepEqual(first.tree, second.tree);
});

test("[R-CHECK-ACCEPTANCE] the decoder rejects malformed documents instead of repairing them", { skip }, async () => {
  const checker = await realChecker();
  const cases = [
    [{ kind: "text" }, /missing-field:text/],
    [{ kind: "text", text: 7 }, /field-not-string:text/],
    [{ kind: "text", text: "a", ns: "html" }, /unknown-field:ns/],
    [{ kind: "mystery" }, /unknown-node-kind/],
    [{ kind: "root", children: [] }, /unknown-node-kind/],
    [{ kind: "el", ns: "html", tag: "p", children: [] }, /missing-field:attrs/],
    [{ kind: "el", ns: "html", tag: "", attrs: [], children: [] }, /tag-empty/],
    // A malformed attribute entry is an ERROR, not a silent drop. This is the
    // exact behaviour `rawFromJson` gets wrong and the strict decoder must not.
    [{ kind: "el", ns: "html", tag: "p", attrs: [["class"]], children: [] }, /attr-not-string-pair/],
    [{ kind: "el", ns: "html", tag: "p", attrs: [["class", 1]], children: [] }, /attr-not-string-pair/],
    [{ kind: "el", ns: "html", tag: "p", attrs: [{ class: "a" }], children: [] }, /attr-not-array/],
    [{ kind: "el", ns: "html", tag: "p", attrs: [["", "a"]], children: [] }, /attr-name-empty/],
    // Duplicate attribute names. parse5 never produces these, but a candidate
    // builder could, and then the two checkers might disagree about which one
    // wins. Refused rather than resolved.
    [{ kind: "el", ns: "html", tag: "p", attrs: [["class", "a"], ["class", "b"]], children: [] }, /duplicate-attribute:class/],
  ];
  for (const [node, pattern] of cases) {
    const verdict = checker.check("r", doc(node));
    assert.equal(verdict.status, "error", JSON.stringify(node));
    assert.equal(verdict.reason.code, "lean-protocol-error", JSON.stringify(node));
    assert.match(verdict.reason.detail, pattern, JSON.stringify(node));
    assert.equal(verdict.tree, undefined);
  }
  // A non-root document, and a document that is not an object at all.
  for (const bad of [el([]), doc.length === 0 ? null : [], "x", 7, null]) {
    const verdict = checker.check("r", bad);
    assert.equal(verdict.status, "error", JSON.stringify(bad));
  }
});

test("[R-CHECK-ACCEPTANCE] NULs, lone surrogates and supplementary characters convert with defined behaviour", { skip }, async () => {
  const checker = await realChecker();
  // A supplementary character survives intact and counts as two UTF-16 units
  // on both sides of the boundary.
  const emoji = "\u{1F600}";
  const kept = checker.check("r", doc(el([txt(`a${emoji}b`)], [], "p")));
  assert.equal(kept.status, "accepted");
  assert.equal(kept.tree.children[0].children[0].text, `a${emoji}b`);
  assert.equal(emoji.length, 2);

  // A lone surrogate is not a character. `JSON.stringify` emits it as a \\uD800
  // escape (well-formed JSON since ES2019), the Lean reader maps it to U+FFFD,
  // and the policy then treats that as ordinary text. The important property is
  // that it is DEFINED and does not corrupt the rest of the string.
  const lone = checker.check("r", doc(el([txt("a\uD800b")], [], "p")));
  assert.equal(lone.status, "accepted");
  assert.equal(lone.tree.children[0].children[0].text, "a�b");

  // A NUL is valid UTF-8 and is transported, then removed by the policy's text
  // predicate. The candidate ABI refuses it without repairing or truncating.
  const nul = checker.check("r", doc(el([txt("a b")], [], "p")));
  assert.equal(nul.status, "rejected");
  assert.equal(nul.tree, undefined);

  // A NUL in an attribute name cannot smuggle an allowed name past the
  // allowlist: the candidate is rejected.
  const nulAttr = checker.check("r", doc(el([txt("x")], [["cla ss", "card"]], "p")));
  assert.equal(nulAttr.status, "rejected");
  assert.equal(nulAttr.tree, undefined);
});

test("[R-LIMIT-TREE] the decoder's own bounds refuse oversized documents before the checker walks them", { skip }, async () => {
  const checker = await realChecker();
  let deep = el([txt("x")]);
  for (let i = 1; i < PREPROCESS_LIMITS.maxRawDepth + 2; i++) deep = el([deep]);
  const tooDeep = checker.check("r", doc(deep));
  assert.equal(tooDeep.status, "error");
  assert.match(tooDeep.reason.detail, /raw-depth-exceeded/);

  // The module's own bound, not the frontend's: this is the backstop for a
  // caller that hands the checker a raw tree directly.
  const tooMany = doc(...Array.from({ length: checker.identity.limits.maxRawNodes + 1 }, () => txt("x")));
  const wide = checker.check("r", tooMany);
  assert.equal(wide.status, "error");
  assert.match(wide.reason.detail, /raw-nodes-exceeded/);

  const tooManyAttrs = doc(el([], Array.from({ length: PREPROCESS_LIMITS.maxRawAttrsPerElement + 1 }, (_, i) => [`data-x${i}`, "1"]), "p"));
  const attrs = checker.check("r", tooManyAttrs);
  assert.equal(attrs.status, "error");
  assert.match(attrs.reason.detail, /raw-attrs-exceeded/);
});

test("[R-CHECK-ACCEPTANCE] the shim refuses malformed protocol data at the memory boundary", { skip }, async () => {
  // Low-level: bypass the glue to exercise the C shim's own checks, which the
  // glue's own validation would otherwise make unreachable.
  const createModule = await rawCreateModule();
  const Module = await createModule({ wasmBinary: rawWasmBinary() });
  const fn = (name, ret, args) => Module.cwrap(name, ret, args);
  const api = {
    init: fn("guard_init", "number", []),
    check: fn("guard_check", "number", ["number"]),
    configure: fn("guard_configure_seal", "number", ["number"]),
    isConfigured: fn("guard_is_configured", "number", []),
    inputBuffer: fn("guard_input_buffer", "number", []),
    inputCapacity: fn("guard_input_capacity", "number", []),
    responseLen: fn("guard_response_len", "number", []),
    release: fn("guard_response_release", null, []),
  };
  assert.equal(api.init(), 0);
  const ptr = api.inputBuffer();
  const capacity = api.inputCapacity();
  assert.ok(capacity >= PREPROCESS_LIMITS.maxCandidateUtf8Bytes, `input capacity ${capacity}`);

  // Before configuration nothing can be checked at all: the class allowlist is
  // a property of the instance, not of a request. That check comes FIRST, so
  // an unconfigured instance reports the missing configuration rather than
  // whatever else is wrong with the request.
  assert.equal(api.isConfigured(), 0);
  const request = new TextEncoder().encode(checkRequest("r", doc()));
  Module.HEAPU8.set(request, ptr);
  assert.equal(api.check(request.length), -5, "unconfigured instance must refuse (GUARD_ERR_NOT_CONFIGURED)");
  assert.equal(api.check(capacity + 1), -5, "and it refuses for that reason before looking at the length");
  assert.equal(shimCode(-5), "lean-not-configured");
  assert.equal(api.responseLen(), 0, "a refused call installs no response");

  // Configure, then the same request works and the seal is visible.
  const config = new TextEncoder().encode(configureRequest({ classes: ["card"], stylesheetHash: "low-level" }));
  Module.HEAPU8.set(config, ptr);
  assert.equal(api.configure(config.length), 0);
  assert.equal(api.isConfigured(), 1);
  api.release();
  Module.HEAPU8.set(request, ptr);
  assert.equal(api.check(request.length), 0);
  assert.ok(api.responseLen() > 0);
  api.release();

  // A length beyond the staging buffer is refused without reading it.
  assert.equal(api.check(capacity + 1), -2);
  assert.equal(api.check(-1), -2);
  assert.equal(shimCode(-2), "lean-request-too-long");

  // Invalid UTF-8 is refused before it becomes a Lean string. A bare 0x80
  // continuation byte, a truncated 3-byte sequence, an overlong encoding of
  // "/" and a UTF-8-encoded surrogate are all rejected.
  for (const bytes of [[0x80], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff]]) {
    Module.HEAPU8.set(bytes, ptr);
    assert.equal(api.check(bytes.length), -3, `expected GUARD_ERR_UTF8 for ${bytes}`);
  }
  assert.equal(shimCode(-3), "lean-request-not-utf8");
  // Valid multi-byte UTF-8 is NOT rejected by that validator: it gets as far as
  // the JSON reader, which refuses it as malformed protocol data instead.
  const valid = new TextEncoder().encode("\u00e9\u20ac\u{1F600}");
  Module.HEAPU8.set(valid, ptr);
  assert.equal(api.check(valid.length), 0);
  api.release();

  // A failing call installs no response, so a caller that ignores the status
  // reads zero bytes rather than stale bytes.
  Module.HEAPU8.set([0x80], ptr);
  assert.equal(api.check(1), -3);
  assert.equal(api.responseLen(), 0);
  // Releasing with nothing installed is safe and idempotent.
  api.release();
  api.release();
  assert.equal(api.responseLen(), 0);
  // Once sealed, a DIFFERENT configuration is refused by the seal itself,
  // before Lean is asked whether it would have been acceptable.
  const other = new TextEncoder().encode(configureRequest({ classes: ["card", "muted"], stylesheetHash: "low-level" }));
  Module.HEAPU8.set(other, ptr);
  assert.equal(api.configure(other.length), -4);
  assert.equal(shimCode(-4), "lean-configuration-sealed");
  assert.equal(api.isConfigured(), 1);
  api.release();

  // A configuration Lean itself refuses never becomes the seal. That path is
  // only reachable on an unsealed instance, so this uses a fresh one.
  const fresh = await createModule({ wasmBinary: rawWasmBinary() });
  const freshConfigure = fresh.cwrap("guard_configure_seal", "number", ["number"]);
  const freshIsConfigured = fresh.cwrap("guard_is_configured", "number", []);
  const freshPtr = fresh.cwrap("guard_input_buffer", "number", [])();
  assert.equal(fresh.cwrap("guard_init", "number", [])(), 0);
  for (const payload of [
    // An unknown profile, a bad ABI, an unknown field, and not JSON at all.
    JSON.stringify({ abi: LEAN_ABI_VERSION, op: "configure", profile: "other", classes: [], stylesheetHash: "h" }),
    JSON.stringify({ abi: 99, op: "configure", profile: LEAN_PROFILE, classes: [], stylesheetHash: "h" }),
    JSON.stringify({ abi: LEAN_ABI_VERSION, op: "configure", profile: LEAN_PROFILE, classes: [], stylesheetHash: "h", extra: 1 }),
    "not json",
  ]) {
    const bytes = new TextEncoder().encode(payload);
    fresh.HEAPU8.set(bytes, freshPtr);
    assert.equal(freshConfigure(bytes.length), -9, `a refused configuration must not be sealed: ${payload.slice(0, 40)}`);
    assert.equal(freshIsConfigured(), 0);
    fresh.cwrap("guard_response_release", null, [])();
  }
  assert.equal(shimCode(-9), "lean-configuration-refused");
});

test("[R-CHECK-ACCEPTANCE] the response validator refuses anything that is not this build's verdict", () => {
  const identity = { abi: LEAN_ABI_VERSION, checkerVersion: LEAN_CHECKER_VERSION, capabilityVersion: EXPECTED_IDENTITY.capabilityVersion, profile: LEAN_PROFILE };
  const base = { abi: LEAN_ABI_VERSION, op: "check", requestId: "r", checker: identity, status: "accepted", tree: doc(), changes: 0, changeKinds: [], changeRules: [] };
  assert.equal(readCheckResponse(JSON.stringify(base), "r").status, "accepted");
  const forbidden = doc(el([], [], "script"));
  const bad = [
    [{ ...base, abi: 99 }, "lean-abi-mismatch"],
    [{ ...base, op: "configure" }, "lean-op-mismatch"],
    [{ ...base, requestId: "other" }, "lean-request-id-mismatch"],
    [{ ...base, checker: { ...identity, checkerVersion: "guard-checker/9.9" } }, "lean-checker-version-mismatch"],
    [{ ...base, checker: { ...identity, capabilityVersion: 99 } }, "lean-capability-version-mismatch"],
    [{ ...base, checker: { ...identity, profile: "other" } }, "lean-profile-mismatch"],
    [{ ...base, checker: undefined }, "lean-checker-identity-missing"],
    [{ ...base, status: "validated" }, "lean-unknown-status"],
    [{ ...base, tree: undefined }, "lean-accepted-without-tree"],
    [{ ...base, tree: { kind: "el", children: [] } }, "lean-tree-not-root"],
    [{ ...base, tree: { kind: "root", children: [{ kind: "el" }] } }, "lean-tree-malformed"],
    [{ ...base, tree: doc(doc()) }, "lean-tree-malformed"],
    // A rejection must not smuggle a tree back with it.
    [{ ...base, status: "rejected", reasons: ["x"], tree: forbidden }, "lean-rejected-with-tree"],
  ];
  for (const [message, code] of bad) {
    const result = readCheckResponse(JSON.stringify(message), "r");
    assert.equal(result.status, "error", JSON.stringify(message).slice(0, 80));
    assert.equal(result.reason.code, code, JSON.stringify(message).slice(0, 80));
    assert.equal(result.tree, undefined);
  }
  for (const text of ["", "not json", "[]", "null", "7"]) {
    assert.equal(readCheckResponse(text, "r").status, "error", text);
  }
});

// ---------------------------------------------------------------------------
// Control 1: Lean rejects a benign candidate
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] control: when Lean rejects a benign document, nothing is accepted and no tree leaves the Worker", async () => {
  const core = createPolicyCore({ classes: CLASSES, checker: rejectingChecker() });
  const reply = handlePolicyRequest(core, envelope());
  assert.equal(reply.status, "rejected");
  assert.equal(reply.reason.code, "lean-rejected");
  assert.match(reply.reason.detail, /injected-negative-control/);
  assert.equal(reply.tree, undefined);
  assert.equal(reply.acceptance, undefined);
  assert.equal(reply.authority, undefined);

  // End to end through the client: the render path never receives a record.
  const { client } = session({ core });
  const result = await client.preprocess(BENIGN);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "lean-rejected");
  assert.equal(result.acceptance, undefined);
  assert.equal(client.stats.accepted, 0);
  client.dispose();
});

// ---------------------------------------------------------------------------
// Control 2: the checker is missing
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] control: with no checker installed every document is refused, and there is no JS fallback", async () => {
  const core = createPolicyCore({ classes: CLASSES });
  assert.equal(core.authority, null);
  for (const html of [BENIGN, "<p>plain</p>", "", "<script>alert(1)</script>"]) {
    const reply = handlePolicyRequest(core, envelope({ html }));
    assert.equal(reply.status, "rejected", html);
    assert.equal(reply.reason.code, "checker-unavailable", html);
    assert.equal(reply.tree, undefined);
  }
  const { client } = session({ core });
  const result = await client.preprocess(BENIGN);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "checker-unavailable");
  client.dispose();
});

test("[R-CHECK-ACCEPTANCE] control: a poisoned instance refuses without calling the module", async () => {
  const core = createPolicyCore({ classes: CLASSES, checker: poisonedChecker() });
  const reply = handlePolicyRequest(core, envelope());
  assert.equal(reply.status, "rejected");
  assert.equal(reply.reason.code, "checker-poisoned");
  assert.equal(reply.tree, undefined);
});

// ---------------------------------------------------------------------------
// Control 3: the module is corrupt, empty, or has the wrong exports
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] control: a corrupt or absent module fails startup and never yields a working checker", { skip }, async () => {
  const createModule = await rawCreateModule();
  const good = rawWasmBinary();

  // The Emscripten glue reports a corrupt module twice: it rejects the promise
  // we await AND aborts, which leaves one unobserved rejection behind. Node
  // terminates the process for an unhandled rejection, so this test would take
  // the rest of the file down with it. Swallow it for the duration and record
  // what was swallowed.
  //
  // In the browser this is not a crash: `createLeanChecker` is awaited inside
  // the policy Worker's try/catch, so the failure becomes `policy/failed` and
  // the session refuses every document -- which is the behaviour the next test
  // covers. The stray rejection only shows up as a console warning there.
  const swallowed = [];
  const swallow = (reason) => swallowed.push(String(reason && reason.message ? reason.message : reason).slice(0, 120));
  process.on("unhandledRejection", swallow);
  try {

  // Emscripten reports a CompileError on stderr through its own printErr before
  // rejecting, so the two deliberately unloadable binaries below would print
  // "Aborted(CompileError ...)" into every test run. Silence only those two
  // calls; every other module in this file keeps the default reporting.
  const quiet = (config) => createModule({ ...config, print: () => {}, printErr: () => {} });

  // Truncated: not a loadable module.
  await assert.rejects(() => createLeanChecker({
    createModule: quiet, wasmBinary: good.slice(0, Math.floor(good.length / 2)), classes: CLASSES, stylesheetHash: "h",
  }));

  // Byte-flipped in the middle of the code section.
  const flipped = good.slice();
  for (let i = 0; i < 4096; i++) flipped[Math.floor(flipped.length / 2) + i] ^= 0xff;
  await assert.rejects(() => createLeanChecker({
    createModule: quiet, wasmBinary: flipped, classes: CLASSES, stylesheetHash: "h",
  }));

  // Absent, and not a Uint8Array at all.
  for (const binary of [undefined, null, new Uint8Array(0), "bytes", [1, 2, 3]]) {
    await assert.rejects(
      () => createLeanChecker({ createModule, wasmBinary: binary, classes: CLASSES, stylesheetHash: "h" }),
      /wasmBinary/,
    );
  }
  await assert.rejects(
    () => createLeanChecker({ createModule: null, wasmBinary: good, classes: CLASSES, stylesheetHash: "h" }),
    /createModule/,
  );

  // A module that loads but does not export the ABI.
  await assert.rejects(
    () => createLeanChecker({ createModule: async () => ({ cwrap: () => { throw new Error("no such export"); } }), wasmBinary: good, classes: CLASSES, stylesheetHash: "h" }),
    /expected ABI/,
  );
  } finally {
    // Give the stray rejections a turn to arrive before uninstalling the guard.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", swallow);
  }
  // The failures were real compile/abort errors, not something else.
  for (const message of swallowed) {
    assert.match(message, /CompileError|Aborted|WebAssembly/i, `unexpected unhandled rejection: ${message}`);
  }
});

test("[R-CHECK-ACCEPTANCE] control: a worker that reports a failed checker kills the session instead of degrading", async () => {
  // A detail the host can classify: a refused Wasm compile is a missing
  // 'wasm-unsafe-eval' in the HOST policy, because a blob: Worker inherits it.
  // Reporting that as a generic build failure would send a consumer looking in
  // the wrong place.
  const csp = session({ core: null, failed: { code: "checker-init-failed", detail: "CompileError: Refused to compile or instantiate WebAssembly module" } });
  await assert.rejects(() => csp.client.start(), (error) => {
    assert.equal(error.code, "csp-wasm-unsafe-eval");
    assert.equal(error.stage, "wasm-init");
    assert.match(error.hint, /'wasm-unsafe-eval'/);
    return true;
  });
  csp.client.dispose();

  // A detail that names nothing recognizable stays the generic code, and its
  // hint says there is no fallback.
  const { client } = session({ core: null, failed: { code: "checker-init-failed", detail: "lean-checker-version-mismatch: guard-checker/9.9" } });
  await assert.rejects(() => client.start(), (error) => {
    assert.equal(error.code, "checker-init-failed");
    assert.equal(error.stage, "wasm-init");
    assert.match(error.hint, /no fallback/i);
    return true;
  });
  const result = await client.preprocess(BENIGN);
  assert.equal(result.status, "rejected");
  assert.ok(["session-terminated", "timeout"].includes(result.reason.code), result.reason.code);
  client.dispose();
});

test("[R-CHECK-ACCEPTANCE] control: a worker whose checker identity is not this build's is refused", async () => {
  const { client } = session({ core: null, identity: { ...EXPECTED_IDENTITY, checkerVersion: "guard-checker/9.9" } });
  await assert.rejects(() => client.start());
  assert.equal(client.checker, null);
  client.dispose();
});

// ---------------------------------------------------------------------------
// Control 4: the checker never finishes starting
// ---------------------------------------------------------------------------

test("[R-RT-LIMITS] control: a stalled wasm-init is a bounded failure with its own code, not a hang", async () => {
  const terminations = [];
  const { worker, client } = session(
    { core: null, checkerReady: false },
    { onTerminated: (event) => terminations.push(event) },
  );
  const starting = client.start();
  await client.whenReady(); // the channel handshake still completes
  await assert.rejects(() => starting, (error) => {
    assert.equal(error.code, "wasm-init-timeout");
    assert.equal(error.stage, "wasm-init");
    return true;
  });
  assert.equal(worker.terminated, true);
  assert.deepEqual(terminations.map((event) => event.code), ["wasm-init-timeout"]);
  client.dispose();
});

test("[R-RT-LIMITS] control: a stalled request terminates the Worker and settles with a timeout", async () => {
  const core = createPolicyCore({ classes: CLASSES, checker: rejectingChecker() });
  const { worker, client } = session({ core, hang: true });
  const result = await client.preprocess(BENIGN);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "timeout");
  assert.equal(worker.terminated, true);
  assert.equal(client.pendingCount, 0);
  client.dispose();
});

// ---------------------------------------------------------------------------
// Control 5: spoofed replies
// ---------------------------------------------------------------------------

test("[R-FRAME-MESSAGE-SCHEMA] control: a spoofed acceptance is refused -- wrong authority, fabricated record, or none at all", { skip }, async () => {
  const checker = await realChecker();
  const core = createPolicyCore({ classes: CLASSES, checker });
  const fabricated = {
    nonce: "f".repeat(ACCEPTANCE_NONCE_BYTES * 2),
    authority: LEAN_AUTHORITY,
    abi: LEAN_ABI_VERSION,
    checkerVersion: LEAN_CHECKER_VERSION,
    capabilityVersion: EXPECTED_IDENTITY.capabilityVersion,
    profile: LEAN_PROFILE,
    instanceId: "i",
    sessionId: "s",
    generation: 0,
    requestId: 1,
    treeNodes: 1,
    treeUtf8Bytes: 1,
  };
  const spoofs = [
    [(reply) => ({ ...reply, authority: "js-checker" }), "authority-not-lean"],
    [(reply) => ({ ...reply, authority: undefined }), "authority-not-lean"],
    [(reply) => ({ ...reply, acceptance: undefined }), "acceptance-malformed"],
    [(reply) => ({ ...reply, acceptance: { ...reply.acceptance, nonce: "short" } }), "acceptance-malformed"],
    [(reply) => ({ ...reply, acceptance: { ...reply.acceptance, requestId: 99 } }), "acceptance-identity-mismatch"],
    [(reply) => ({ ...reply, acceptance: { ...reply.acceptance, instanceId: "somebody-else" } }), "acceptance-identity-mismatch"],
    [(reply) => ({ ...reply, acceptance: { ...reply.acceptance, checkerVersion: "guard-checker/9.9" } }), "acceptance-checker-version"],
    [(reply) => ({ ...reply, acceptance: fabricated }), "acceptance-identity-mismatch"],
  ];
  for (const [mangle, code] of spoofs) {
    const { client } = session({ core, mangle });
    const result = await client.preprocess(BENIGN);
    assert.equal(result.status, "rejected", code);
    assert.equal(result.reason.code, code);
    assert.equal(result.acceptance, undefined);
    assert.equal(client.stats.accepted, 0);
    client.dispose();
  }
});

test("[R-FRAME-MESSAGE-SCHEMA] control: a fabricated record cannot be claimed, and a superseded one cannot either", { skip }, async () => {
  const checker = await realChecker();
  const core = createPolicyCore({ classes: CLASSES, checker });
  const { client } = session({ core });
  const accepted = await client.preprocess(BENIGN);
  assert.equal(accepted.status, "accepted");

  // Retired reference registry, not a session/frame commit API.
  assert.equal(client.claimAcceptance, undefined);
  const registry = createAcceptanceRegistry();
  registry.record(accepted.acceptance, accepted.tree);
  // A record this session never issued.
  const forged = { ...accepted.acceptance, nonce: "0".repeat(ACCEPTANCE_NONCE_BYTES * 2) };
  assert.equal(registry.claim(forged).ok, false);
  assert.equal(registry.claim(forged).reason.code, "acceptance-unknown-or-claimed");
  // Nonsense shapes.
  for (const bad of [null, undefined, {}, "nonce", { nonce: 1 }, { ...accepted.acceptance, nonce: "zz" }]) {
    assert.equal(registry.claim(bad).ok, false);
  }
  // The genuine one still works exactly once.
  assert.equal(registry.claim(accepted.acceptance).ok, true);

  // A record whose document has been superseded is dropped when the generation
  // advances, so a late commit cannot render content the app moved past.
  const second = await client.preprocess(BENIGN);
  assert.equal(second.status, "accepted");
  registry.record(second.acceptance, second.tree);
  client.nextGeneration();
  registry.invalidate(token => token.generation !== client.generation);
  const stale = registry.claim(second.acceptance);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason.code, "acceptance-unknown-or-claimed");
  client.dispose();
});

// ---------------------------------------------------------------------------
// Control 6: replay
// ---------------------------------------------------------------------------

test("[R-FRAME-MESSAGE-SCHEMA] control: an acceptance record is one-time, so a replay renders nothing", { skip }, async () => {
  const checker = await realChecker();
  const core = createPolicyCore({ classes: CLASSES, checker });
  const { client } = session({ core });
  const accepted = await client.preprocess(BENIGN);
  const registry = createAcceptanceRegistry();
  registry.record(accepted.acceptance, accepted.tree);
  const first = registry.claim(accepted.acceptance);
  assert.equal(first.ok, true);
  assert.deepEqual(first.tree, accepted.tree);
  const replay = registry.claim(accepted.acceptance);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason.code, "acceptance-unknown-or-claimed");
  assert.equal(registry.stats.claimed, 1);
  assert.equal(registry.stats.refused, 1);
  client.dispose();
});

test("[R-FRAME-MESSAGE-SCHEMA] the registry is bounded and cannot be made to hold unclaimed trees", () => {
  const registry = createAcceptanceRegistry({ max: 2 });
  const make = (requestId) => mintAcceptance({
    authority: LEAN_AUTHORITY,
    checker: { abi: LEAN_ABI_VERSION, checkerVersion: LEAN_CHECKER_VERSION, capabilityVersion: EXPECTED_IDENTITY.capabilityVersion, profile: LEAN_PROFILE },
    instanceId: "i", sessionId: "s", generation: 0, requestId, treeNodes: 1, treeUtf8Bytes: 1,
  });
  const tokens = [make(1), make(2), make(3)];
  for (const token of tokens) {
    assert.ok(isAcceptanceToken(token));
    assert.equal(registry.record(token, doc()).ok, true);
  }
  assert.equal(registry.size, 2);
  assert.equal(registry.stats.evicted, 1);
  // The evicted one is the oldest, and it is gone for good.
  assert.equal(registry.claim(tokens[0]).ok, false);
  assert.equal(registry.claim(tokens[2]).ok, true);
  // Nonces are unique and unguessable-shaped.
  assert.equal(new Set(tokens.map((t) => t.nonce)).size, 3);
  for (const token of tokens) assert.match(token.nonce, /^[0-9a-f]{32}$/);
  // Recording the same nonce twice is refused rather than overwriting a tree.
  const again = make(4);
  assert.equal(registry.record(again, doc()).ok, true);
  assert.equal(registry.record(again, doc(el([], [], "script"))).ok, false);
});

// ---------------------------------------------------------------------------
// Control 7: the JS candidate builder is forced to emit a forbidden tree
// ---------------------------------------------------------------------------

test("[R-CHECK-ACCEPTANCE] control: a candidate builder forced to emit a forbidden tree cannot get it rendered", { skip }, async () => {
  const checker = await realChecker();
  const forbidden = [
    doc(el([], [], "script")),
    doc(el([], [["onclick", "steal()"]], "div")),
    doc(el([], [["src", "https://attacker.invalid/x"]], "img")),
    doc(el([], [], "iframe")),
    doc(el([], [["title", "a"], ["class", "card"]], "div")),
    doc(el([], [["class", "card"], ["class", "card"]], "div")),
    doc(el([], [], "DIV")),
    doc(el([], [], "button")),
    doc(txt("")),
  ];
  for (const tree of forbidden) {
    const core = createPolicyCore({
      classes: CLASSES,
      checker,
      candidateBuilder: () => ({ status: "proposed", tree, changes: [] }),
    });
    const reply = handlePolicyRequest(core, envelope());
    assert.equal(reply.status, "rejected", JSON.stringify(tree).slice(0, 60));
    assert.ok(["lean-rejected", "lean-error", "candidate-rejected"].includes(reply.reason.code), reply.reason.code);
    assert.equal(reply.tree, undefined);
    assert.equal(reply.acceptance, undefined);
  }
  // A benign substitution is intentionally a proposal, not a raw-input
  // equivalence check. Lean accepts the candidate itself exactly once.
  const replacement = doc(el([txt("substituted")], [["class", "card"]], "p"));
  let checks = 0;
  const proposing = createPolicyCore({ classes: CLASSES,
    checker: { identity: checker.identity, check(id, tree) { checks++; assert.deepEqual(tree, replacement); return checker.check(id, tree); } },
    candidateBuilder: () => ({ status: "proposed", tree: replacement, changes: [] }),
  });
  const acceptedProposal = handlePolicyRequest(proposing, envelope());
  assert.equal(acceptedProposal.status, "accepted");
  assert.deepEqual(acceptedProposal.tree, replacement);
  assert.equal(checks, 1);

  // A builder refusal never falls back to normalizing raw input in Lean.
  const rejecting = createPolicyCore({
    classes: CLASSES,
    checker,
    candidateBuilder: () => ({ status: "rejected", reasons: [{ code: "candidate-says-no" }] }),
  });
  const reply = handlePolicyRequest(rejecting, envelope());
  assert.ok(["lean-rejected", "lean-error", "candidate-rejected"].includes(reply.reason.code), reply.reason.code);
  assert.match(reply.reason.detail, /candidate-says-no/);
});

test("[R-CHECK-ACCEPTANCE] control: a checker that claims acceptance without a usable tree is refused", async () => {
  for (const tree of [undefined, null, "tree", { kind: "el", children: [] }, { kind: "root" }]) {
    const core = createPolicyCore({ classes: CLASSES, checker: corruptChecker(tree) });
    const reply = handlePolicyRequest(core, envelope());
    assert.equal(reply.status, "rejected", JSON.stringify(tree));
    assert.ok(["authority-tree-malformed", "worker-fault"].includes(reply.reason.code), reply.reason.code);
    assert.equal(reply.acceptance, undefined);
  }
  // A checker that returns no verdict at all, or a nonsense one.
  for (const verdict of [undefined, null, "accepted", 7, { status: "maybe" }]) {
    const core = createPolicyCore({ classes: CLASSES, checker: stubChecker(() => verdict) });
    const reply = handlePolicyRequest(core, envelope());
    assert.equal(reply.status, "rejected", JSON.stringify(verdict));
    assert.ok(["authority-malformed", "lean-error"].includes(reply.reason.code), reply.reason.code);
  }
});

// ---------------------------------------------------------------------------
// Control 8: a message cannot install, replace or disable a checker
// ---------------------------------------------------------------------------

test("[R-RT-ISOLATION] control: no message field can install, replace or disable the authority", { skip }, async () => {
  const checker = await realChecker();
  const core = createPolicyCore({ classes: CLASSES, checker });
  // Every field a hostile or buggy caller might try. The reply must still come
  // from the real authority, with a real record.
  const attempts = [
    { checker: { check: () => ({ status: "accepted", tree: doc(el([], [], "script")) }) } },
    { candidateBuilder: () => ({ status: "proposed", tree: doc(el([], [], "script")), changes: [] }) },
    { acceptance: { ok: true } },
    { authority: "js-checker" },
    { validated: true },
    { tree: doc(el([], [], "script")) },
    { limits: { maxRawNodes: 1 } },
    { profile: "other" },
  ];
  for (const extra of attempts) {
    const reply = handlePolicyRequest(core, envelope(extra));
    assert.equal(reply.status, "accepted", JSON.stringify(extra));
    assert.equal(reply.authority, LEAN_AUTHORITY);
    assert.ok(isAcceptanceToken(reply.acceptance));
    assert.ok(!JSON.stringify(reply.tree).includes("script"), JSON.stringify(extra));
    // The document that was checked is the `html` field, not any tree the
    // message supplied.
    assert.equal(reply.tree.children[0].tag, "p");
  }
  // And with no checker installed, a message carrying an "acceptance" still
  // gets nothing.
  const empty = createPolicyCore({ classes: CLASSES });
  assert.equal(handlePolicyRequest(empty, envelope({ acceptance: { ok: true } })).reason.code, "checker-unavailable");

  // A message cannot widen the class allowlist either. The instance's list is
  // the one that was sealed into the module; a request that disagrees with it
  // is refused explicitly, rather than adopted and then discovered later as a
  // candidate/authority mismatch.
  for (const classes of [[...CLASSES, "evil"], ["evil"], [], CLASSES.slice(0, 1)]) {
    const reply = handlePolicyRequest(core, envelope({ classes, html: `<p class="evil">x</p>` }));
    assert.equal(reply.status, "rejected", JSON.stringify(classes));
    assert.equal(reply.reason.code, "class-allowlist-mismatch");
  }
  // The matching list is accepted, and "evil" is still not a permitted class.
  const matching = handlePolicyRequest(core, envelope({ classes: [...CLASSES], html: `<p class="card evil">x</p>` }));
  assert.equal(matching.status, "accepted");
  assert.deepEqual(matching.tree.children[0].attrs, [["class", "card"]]);
});

// ---------------------------------------------------------------------------
// Control 9: the module traps and the instance is poisoned
// ---------------------------------------------------------------------------

test("[R-RT-LIMITS] control: a trap inside the module poisons the instance instead of being retried", { skip }, async () => {
  // A real trap: the Lean checker recurses once per sibling, and that
  // recursion lives on the ENGINE's call stack, which -sSTACK_SIZE does not
  // configure. `maxRawPathNodes` keeps documents that reach here well below the
  // measured threshold (see src/policy-protocol.js), so this calls the checker
  // directly with a tree the frontend would never forward.
  const checker = await realChecker({ fresh: true });
  const huge = doc(...Array.from({ length: 40_000 }, () => txt("x")));
  const verdict = checker.check("trap", huge);
  // Whatever happens, it is NOT an acceptance.
  assert.notEqual(verdict.status, "accepted");
  if (checker.poisoned) {
    // The trap was observed: every later call refuses, including a benign one,
    // and the instance is never reused.
    assert.equal(verdict.reason.code, "lean-checker-poisoned");
    const later = checker.check("after", doc(el([txt("x")], [["class", "card"]], "p")));
    assert.equal(later.status, "error");
    assert.equal(later.reason.code, "lean-checker-poisoned");
    // And the policy core refuses without calling the module at all.
    const core = createPolicyCore({ classes: CLASSES, checker });
    assert.equal(handlePolicyRequest(core, envelope()).reason.code, "checker-poisoned");
  } else {
    // The decoder's node bound caught it first, which is the intended order.
    assert.equal(verdict.status, "error");
    assert.match(verdict.reason.detail ?? "", /raw-nodes-exceeded/);
  }
});

test("[R-RT-LIMITS] a module whose call throws is poisoned permanently and answers nothing afterwards", async () => {
  // Deterministic version of the control above, with a module that traps on
  // demand. It pins the POLICY -- poison, never reset -- independently of
  // whether a particular engine overflows at a particular width.
  let calls = 0;
  const heap = new Uint8Array(4_000_000);
  const responses = [];
  const fakeModule = async () => ({
    HEAPU8: heap,
    cwrap(name) {
      if (name === "guard_input_buffer") return () => 3_000_000;
      if (name === "guard_input_capacity") return () => 2_200_000;
      if (name === "guard_init") return () => 0;
      if (name === "guard_is_configured") return () => 1;
      if (name === "guard_response_ptr") return () => 0;
      if (name === "guard_response_len") return () => responses.length > 0 ? responses[0].length : 0;
      if (name === "guard_response_release") return () => {};
      // info, configure and the first check succeed; the next check traps.
      return (length) => {
        const text = new TextDecoder().decode(heap.subarray(3_000_000, 3_000_000 + length));
        const request = JSON.parse(text);
        calls += 1;
        if (request.op === "check" && calls > 3) throw new RangeError("Maximum call stack size exceeded");
        const identity = { abi: LEAN_ABI_VERSION, checkerVersion: LEAN_CHECKER_VERSION, capabilityVersion: EXPECTED_IDENTITY.capabilityVersion, profile: LEAN_PROFILE };
        const body = request.op === "configure"
          ? { status: "configured", limits: LEAN_MIN_LIMITS }
          : request.op === "check"
            ? { status: "accepted", tree: doc(), changes: 0, changeKinds: [], changeRules: [] }
            : { status: "info", limits: LEAN_MIN_LIMITS };
        const out = JSON.stringify({ abi: LEAN_ABI_VERSION, op: request.op, requestId: request.requestId ?? "", checker: identity, ...body });
        const bytes = new TextEncoder().encode(out);
        heap.set(bytes, 0);
        responses[0] = bytes;
        return 0;
      };
    },
  });
  // `guard_info` is called with an empty string, which is not JSON, so the
  // stub answers `info` for anything that fails to parse.
  const checker = await createLeanChecker({
    createModule: async (config) => {
      const module = await fakeModule(config);
      const original = module.cwrap;
      module.cwrap = (name, ...rest) => {
        const fn = original(name, ...rest);
        if (name !== "guard_info") return fn;
        return () => {
          const identity = { abi: LEAN_ABI_VERSION, checkerVersion: LEAN_CHECKER_VERSION, capabilityVersion: EXPECTED_IDENTITY.capabilityVersion, profile: LEAN_PROFILE };
          const out = JSON.stringify({ abi: LEAN_ABI_VERSION, op: "info", requestId: "", checker: identity, status: "info", limits: LEAN_MIN_LIMITS });
          const bytes = new TextEncoder().encode(out);
          heap.set(bytes, 0);
          responses[0] = bytes;
          calls += 1;
          return 0;
        };
      };
      return module;
    },
    wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    classes: CLASSES,
    stylesheetHash: "fake",
  });
  assert.equal(checker.poisoned, false);
  assert.equal(checker.check("a", doc()).status, "accepted");
  const trapped = checker.check("b", doc());
  assert.equal(trapped.status, "error");
  assert.equal(trapped.reason.code, "lean-checker-poisoned");
  assert.equal(checker.poisoned, true);
  // Permanently: no reset, no retry, not even for a benign document.
  for (let i = 0; i < 3; i++) {
    assert.equal(checker.check("c", doc()).reason.code, "lean-checker-poisoned");
  }
  assert.equal(checker.tryReconfigure(CLASSES, "fake").reason.code, "lean-checker-poisoned");
});

// ---------------------------------------------------------------------------
// The frame boundary: a commit requires a record, not a tree
// ---------------------------------------------------------------------------

test("[R-FRAME-MESSAGE-SCHEMA] control: a frame has no parent commit API, even with a claimed acceptance", { skip }, async () => {
  const dom = new JSDOM("<!doctype html><div id='c'></div>", { url: "https://host.invalid/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const checker = await realChecker();
    const core = createPolicyCore({ classes: CLASSES, checker });
    const { client } = session({ core });
    const accepted = await client.preprocess(BENIGN);
    assert.equal(accepted.status, "accepted");

    const refusals = [];
    const frame = createSandboxFrame({
      container: dom.window.document.getElementById("c"),
      manifest: { script: "", css: "", scriptHash: "S", cssHash: "C", classes: CLASSES },
      onStatus: ({ kind, detail }) => { if (kind === "refused") refusals.push(detail); },
      startupTimeoutMs: 20,
    });
    assert.equal(frame.render, undefined, "neither a tree nor a genuine/forged token has a commit API");
    assert.equal(frame.clear, undefined, "clear must also go through the authority");
    frame.destroy();
    client.dispose();
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    dom.window.close();
  }
});
