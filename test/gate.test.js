// The optional development linter. Its result is diagnostic eligibility,
// never authorization: confinement is tested without it in
// test/confinement.test.js, and it is no longer on the execution path or in
// the default bundle's dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateProgram, LINT_BUDGETS } from "../src/gate.js";

const GOOD = `
const initialState = { count: 0 };
function update(state, event) {
  if (event.action === "increment") return { ...state, count: state.count + 1 };
  return state;
}
function view(state) {
  return "<p>Count: " + state.count + "</p><button data-action=\\"increment\\">+</button>";
}`;

test("[R-GATE-INTERFACE] accepts the reference interface, labelled as a diagnostic", () => {
  const r = gateProgram(GOOD);
  assert.equal(r.status, "eligible-for-restricted-execution");
  assert.equal(r.program.source, GOOD);
  // Every result says what it is. "Eligible" means no unsupported construct
  // was found; it is not permission to run anything.
  assert.equal(r.kind, "diagnostic");
  assert.equal(r.authorization, "none");
  assert.equal(gateProgram("const x = 1;").kind, "diagnostic");
  assert.equal(gateProgram("const x = 1;").authorization, "none");
});

test("[R-GATE-INTERFACE] rejects programs missing the interface", () => {
  const r = gateProgram(`const x = 1;`);
  assert.equal(r.status, "rejected");
  assert.deepEqual(r.reasons.map((x) => x.name).sort(), ["initialState", "update", "view"]);
});

test("[R-GATE-INTERFACE] static import is a syntax error in script mode", () => {
  const r = gateProgram(GOOD + `\nimport x from "y";`);
  assert.equal(r.status, "rejected");
  assert.equal(r.reasons[0].code, "syntax");
});

test("[R-GATE-INTERFACE] rejects dynamic import, async, generators, eval, Function, denied globals with locations", () => {
  const r = gateProgram(GOOD + `
const m = import("y");
async function f() { await 1; }
function* g() { yield 1; }
const h = eval("1");
const i = new Function("return 1");
fetch("https://x");
globalThis.foo = 1;
window.location = "x";
setTimeout(() => {}, 1);`);
  assert.equal(r.status, "rejected");
  const codes = new Set(r.reasons.map((x) => x.code));
  for (const c of ["module-syntax", "async", "generator", "denied-identifier", "dynamic-code"]) assert.ok(codes.has(c), c);
  assert.ok(r.reasons.every((x) => x.code === "module-syntax" || typeof x.line === "number"));
});

test("[R-GATE-INTERFACE] property names that look like denied identifiers are fine", () => {
  const r = gateProgram(GOOD + `\nconst o = { fetch: 1, window: 2 }; const v2 = o.fetch + o.window;`);
  assert.equal(r.status, "eligible-for-restricted-execution");
});

test("[R-GATE-INTERFACE] syntax errors are reported, not thrown", () => {
  const r = gateProgram(`function (`);
  assert.equal(r.status, "rejected");
  assert.equal(r.reasons[0].code, "syntax");
});

// --- R3: the walk is bounded -----------------------------------------------

test("[R-GATE-INTERFACE] a long property chain is linted iteratively instead of overflowing the stack", () => {
  // The previous recursive walk threw RangeError here, on attacker-controlled
  // input, before any budget applied.
  const chain = `const initialState = a${".b".repeat(20000)};\n` + GOOD.replace("const initialState = { count: 0 };", "");
  const r = gateProgram(chain);
  assert.equal(r.status, "eligible-for-restricted-execution");
  assert.ok(r.visited > 20000, `expected the whole chain to be visited, saw ${r.visited}`);
});

test("[R-GATE-INTERFACE] the node budget stops the walk with a diagnostic, not an exception", () => {
  const r = gateProgram(GOOD + `\nconst deep = a${".b".repeat(5000)};`, { budgets: { maxAstNodes: 500 } });
  assert.equal(r.status, "rejected");
  assert.equal(r.reasons[0].code, "walk-budget");
  assert.equal(r.authorization, "none");
  assert.ok(r.reasons[0].visited > 0);
});

test("[R-GATE-INTERFACE] the time budget stops the walk with a diagnostic", () => {
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 10_000);
  const r = gateProgram(GOOD + `\nconst deep = a${".b".repeat(5000)};`, { now });
  assert.equal(r.status, "rejected");
  assert.equal(r.reasons[0].code, "time-budget");
});

test("[R-GATE-INTERFACE] a source longer than the linter's budget is rejected in code units", () => {
  const r = gateProgram("//" + "x".repeat(LINT_BUDGETS.maxSourceCodeUnits));
  assert.equal(r.status, "rejected");
  assert.equal(r.reasons[0].code, "too-long");
});

test("[R-GATE-INTERFACE] pathological nesting in the parser itself is reported, not thrown", () => {
  // Acorn's own recursion is not this module's to bound; the failure must
  // still arrive as a diagnostic.
  const r = gateProgram("const initialState = " + "(".repeat(40000) + "1" + ")".repeat(40000) + ";");
  assert.equal(r.status, "rejected");
  assert.ok(["syntax", "walk-budget", "time-budget"].includes(r.reasons[0].code), r.reasons[0].code);
});

// --- it is out of the default path -----------------------------------------

test("[R-GATE-INTERFACE] the linter is not in the default entry point or the policy Worker", () => {
  for (const file of ["src/cdn.js", "src/policy-worker.js", "src/policy-core.js", "demo/main.js", "demo/showcase.js"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!code.includes("gate.js"), `${file} still imports the linter`);
    assert.ok(!code.includes("acorn"), `${file} still pulls in Acorn`);
  }
  // It has its own opt-in entry point instead.
  const lint = readFileSync(new URL("../src/cdn-lint.js", import.meta.url), "utf8");
  assert.ok(lint.includes("./gate.js"));
});
