// OPTIONAL DEVELOPMENT LINTER for the interaction source.
//
// This is not a security boundary and it is not on the execution path. The
// boundary is QuickJS: it compiles the program under memory/stack/time limits
// and checks the synchronous initialState/update/view interface, and nothing
// host-owned is reachable from inside it. An identifier denylist cannot be a
// boundary anyway - computed access (globalThis["fe"+"tch"]), constructors,
// aliases and generated source all express the same operations - so nothing
// here is relied upon for confinement. See test/confinement.test.js, which
// exercises QuickJS with this linter bypassed entirely.
//
// What it is for: telling a generator why a program will not work, in terms it
// can act on, before paying for a Worker round trip. Its result is
// DIAGNOSTIC ELIGIBILITY, NEVER AUTHORIZATION: `status ===
// "eligible-for-restricted-execution"` means "no known unsupported construct
// was found", not "this program is safe to run".
//
// It is shipped from a separate entry point (src/cdn-lint.js) so that Acorn
// stays out of the default runtime dependency path.
//
// R3. The AST walk is iterative and bounded by node and time budgets, so a
// long member-expression chain cannot overflow the stack here. Acorn's own
// parser recursion is not bounded by this module; a RangeError from parse() is
// reported as a `syntax` diagnostic rather than propagating.

import { parse } from "acorn";

// Unsupported-in-this-runtime names. A diagnostic list, not an allowlist and
// not a boundary: QuickJS does not provide these regardless of what is
// written here.
const UNSUPPORTED_IDENTIFIERS = new Set([
  "eval", "Function", "globalThis", "window", "self", "document", "fetch",
  "XMLHttpRequest", "WebSocket", "importScripts", "setTimeout", "setInterval",
  "queueMicrotask", "Promise", "Atomics", "SharedArrayBuffer", "WebAssembly",
  "require", "process", "std", "os", "__host",
]);

const REQUIRED = ["initialState", "update", "view"];

export const LINT_BUDGETS = Object.freeze({
  maxSourceCodeUnits: 200_000, // UTF-16 code units
  maxAstNodes: 400_000,        // AST nodes visited
  maxWalkMs: 250,              // wall-clock budget for the walk
});

function diagnostic(body) {
  // `kind` and `authorization` make the contract explicit at every call site
  // and in every serialized report.
  return { kind: "diagnostic", authorization: "none", ...body };
}

export function gateProgram(source, options = {}) {
  const budgets = options.budgets ? { ...LINT_BUDGETS, ...options.budgets } : LINT_BUDGETS;
  const now = options.now ?? Date.now;
  const reasons = [];
  if (typeof source !== "string") {
    return diagnostic({ status: "rejected", reasons: [{ code: "not-a-string" }] });
  }
  if (source.length > budgets.maxSourceCodeUnits) {
    return diagnostic({ status: "rejected", reasons: [{ code: "too-long" }] });
  }

  let ast;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: "script", allowHashBang: false, locations: true });
  } catch (err) {
    // Includes a RangeError from Acorn's own recursion on pathological input.
    return diagnostic({ status: "rejected", reasons: [{ code: "syntax", message: String(err && err.message).slice(0, 200) }] });
  }

  const declared = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === "FunctionDeclaration") declared.add(stmt.id.name);
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) if (d.id.type === "Identifier") declared.add(d.id.name);
    }
  }
  for (const name of REQUIRED) {
    if (!declared.has(name)) reasons.push({ code: "missing", name, message: `top-level ${name} is required` });
  }

  const at = (node) => (node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : {});
  const reject = (node, code, message) => reasons.push({ code, message, ...at(node) });

  const walked = walk(ast, (node, parent) => {
    switch (node.type) {
      case "ImportDeclaration": case "ImportExpression":
      case "ExportNamedDeclaration": case "ExportDefaultDeclaration": case "ExportAllDeclaration":
        reject(node, "module-syntax", "imports and exports are not supported"); break;
      case "AwaitExpression": reject(node, "async", "await is not supported"); break;
      case "YieldExpression": reject(node, "generator", "generators are not supported"); break;
      case "WithStatement": reject(node, "with", "with is not supported"); break;
      case "DebuggerStatement": reject(node, "debugger", "debugger is not supported"); break;
      case "MetaProperty": reject(node, "meta-property", "import.meta and new.target are not supported"); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        if (node.async) reject(node, "async", "async functions are not supported");
        if (node.generator) reject(node, "generator", "generators are not supported");
        break;
      case "Identifier":
        if (UNSUPPORTED_IDENTIFIERS.has(node.name) && !isPropertyKey(node, parent)) {
          reject(node, "denied-identifier", `${node.name} is not available`);
        }
        break;
      case "NewExpression": case "CallExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "Function") {
          reject(node, "dynamic-code", "dynamic code generation is not supported");
        }
        break;
      default: break;
    }
  }, budgets, now);

  if (!walked.ok) {
    // The linter gave up. That is a diagnostic outcome, not a verdict about
    // the program: it says nothing was inspected past the budget.
    return diagnostic({
      status: "rejected",
      reasons: [{ code: walked.code, message: "program exceeds the linter's budget", visited: walked.visited }],
    });
  }

  if (reasons.length) return diagnostic({ status: "rejected", reasons });
  return diagnostic({
    status: "eligible-for-restricted-execution",
    program: { source, gateVersion: 2 },
    visited: walked.visited,
  });
}

function isPropertyKey(node, parent) {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return true;
  if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) return true;
  return false;
}

// Iterative pre-order walk with an explicit stack. Children are pushed in
// reverse so visit order matches the previous recursive implementation.
function walk(root, visit, budgets, now) {
  if (!root || typeof root.type !== "string") return { ok: true, visited: 0 };
  const deadline = now() + budgets.maxWalkMs;
  const stack = [[root, null]];
  let visited = 0;
  const children = [];
  while (stack.length > 0) {
    const [node, parent] = stack.pop();
    if (++visited > budgets.maxAstNodes) return { ok: false, code: "walk-budget", visited };
    if ((visited & 0x3ff) === 0 && now() > deadline) return { ok: false, code: "time-budget", visited };
    visit(node, parent);
    children.length = 0;
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") children.push(child);
      } else if (value && typeof value.type === "string") {
        children.push(value);
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], node]);
  }
  return { ok: true, visited };
}
