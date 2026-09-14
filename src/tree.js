// Structured tree format shared by the policy checker, the renderer and the
// sandboxed frame. This is the ONLY representation that crosses from
// validation to rendering. No HTML string exists after validation.
//
//   Root: { kind: "root", children: Node[] }
//   Node: { kind: "el", ns: "html" | "svg", tag: string,
//           attrs: Array<[name, value]>, children: Node[] }
//       | { kind: "text", text: string }
//
// Attributes are an array of pairs rather than an object so that attribute
// names such as "__proto__" or "constructor" can never become object keys.

export const NS = Object.freeze({
  html: "http://www.w3.org/1999/xhtml",
  svg: "http://www.w3.org/2000/svg",
});

export { POLICY_LIMITS as LIMITS } from "./policy-data.js";
import { POLICY_LIMITS as LIMITS } from "./policy-data.js";

export function el(ns, tag, attrs = [], children = []) {
  return { kind: "el", ns, tag, attrs, children };
}

export function text(s) {
  return { kind: "text", text: s };
}

export function root(children = []) {
  return { kind: "root", children };
}

// Cheap structural check for data that arrived over postMessage or JSON.
// It does not apply policy. Acceptance belongs to Lean; this is the renderer's
// bounded data contract. A nested root is never a renderer node.
export function isTreeShaped(node, depth = 0) {
  if (depth > LIMITS.maxDepth + 1) return false;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  if (depth === 0 && node.kind !== "root") return false;
  if (depth > 0 && node.kind === "root") return false;
  if (node.kind === "text") return typeof node.text === "string";
  if (node.kind === "root" || node.kind === "el") {
    if (!Array.isArray(node.children)) return false;
    if (node.kind === "el") {
      if (node.ns !== "html" && node.ns !== "svg") return false;
      if (typeof node.tag !== "string") return false;
      if (!Array.isArray(node.attrs)) return false;
      for (const a of node.attrs) {
        if (!Array.isArray(a) || a.length !== 2) return false;
        if (typeof a[0] !== "string" || typeof a[1] !== "string") return false;
      }
    }
    return node.children.every((c) => isTreeShaped(c, depth + 1));
  }
  return false;
}
