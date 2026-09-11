import { test } from "node:test";
import assert from "node:assert/strict";
import { gateProgram } from "../src/gate.js";

const GOOD = `
const initialState = { count: 0 };
function update(state, event) {
  if (event.action === "increment") return { ...state, count: state.count + 1 };
  return state;
}
function view(state) {
  return "<p>Count: " + state.count + "</p><button data-action=\\"increment\\">+</button>";
}`;

test("[R-GATE-INTERFACE] accepts the reference interface", () => {
  const r = gateProgram(GOOD);
  assert.equal(r.status, "eligible-for-restricted-execution");
  assert.equal(r.program.source, GOOD);
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
