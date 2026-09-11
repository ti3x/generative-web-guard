// AST gate for the interaction source. This is a COMPATIBILITY and POLICY
// check, not the security boundary: QuickJS isolation is. The gate exists so
// that unsupported programs are rejected with diagnostics the model can act on
// instead of failing at runtime, and so that the supported surface stays
// small and synchronous.

import { parse } from "acorn";

const DENIED_IDENTIFIERS = new Set([
  "eval", "Function", "globalThis", "window", "self", "document", "fetch",
  "XMLHttpRequest", "WebSocket", "importScripts", "setTimeout", "setInterval",
  "queueMicrotask", "Promise", "Atomics", "SharedArrayBuffer", "WebAssembly",
  "require", "process", "std", "os", "__host",
]);

const REQUIRED = ["initialState", "update", "view"];

export function gateProgram(source) {
  const reasons = [];
  if (typeof source !== "string") return { status: "rejected", reasons: [{ code: "not-a-string" }] };
  if (source.length > 200000) return { status: "rejected", reasons: [{ code: "too-long" }] };

  let ast;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: "script", allowHashBang: false, locations: true });
  } catch (err) {
    return { status: "rejected", reasons: [{ code: "syntax", message: err.message }] };
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

  walk(ast, (node, parent) => {
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
        if (DENIED_IDENTIFIERS.has(node.name) && !isPropertyKey(node, parent)) {
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
  });

  if (reasons.length) return { status: "rejected", reasons };
  return { status: "eligible-for-restricted-execution", program: { source, gateVersion: 1 } };
}

function isPropertyKey(node, parent) {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return true;
  if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) return true;
  return false;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") walk(c, visit, node);
    } else if (v && typeof v.type === "string") {
      walk(v, visit, node);
    }
  }
}
