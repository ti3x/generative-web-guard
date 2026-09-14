// Reconstruct-from-allowlist policy. Input is a raw tree produced by a parser
// adapter (see adapters/). Output is a new tree containing only permitted
// constructs, plus a list of changes. Nothing from the input is copied through
// unless a rule explicitly accepts it.
//
// This module is a plain reimplementation of the policy described in PLAN.md
// section 3. It runs in three places: the host (on parser output), the
// sandboxed frame (on every tree it receives, so a forged or stale tree can
// never reach the renderer), and tests. It is written to be a straightforward
// executable specification that a Lean version can be checked against.

import { LIMITS, el, text, root } from "./tree.js";
import { RULES } from "./rules.js";
import { createPolicyTables } from "./policy-data.js";

// Every removal or rewrite cites a rule id from rules/catalog.json. Validators
// carry a default rule; table entries can override it with withRule().
function withRule(rule, fn) {
  const wrapped = (v) => fn(v);
  wrapped.rule = rule;
  return wrapped;
}

// ---------------------------------------------------------------------------
// Value validators. Every attribute value passes through exactly one of these.
// Each returns the canonical value to emit, or null to drop the attribute.

// ASCII-only lowercase. JavaScript's toLowerCase() maps some non-ASCII
// characters (Kelvin sign, dotted I) into ASCII, which would let a name that
// is not in the allowlist match one that is. Names and keywords are ASCII.
export function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// Canonical bounded decimal. Grammar: -? (digits+ | digits* . digits+).
// Purely syntactic so that the Lean checker can mirror it exactly: leading
// zeros in the integer part and trailing zeros in the fraction are dropped,
// -0 becomes 0, magnitude must be at most 1e6, exponents never parse.
const NUM_RE = /^(-?)(\d*)(?:\.(\d+))?$/;

function boundedNumber(v) {
  const m = NUM_RE.exec(v.trim());
  if (!m) return null;
  let [, sign, int, frac = ""] = m;
  if (int === "" && frac === "") return null;
  if (int.length > 7) return null;
  int = int.replace(/^0+/, "");
  if (int === "") int = "0";
  frac = frac.replace(/0+$/, "");
  const n = Number(int);
  if (n > LIMITS.maxNumberMagnitude || (n === LIMITS.maxNumberMagnitude && frac !== "")) return null;
  if (int === "0" && frac === "") return "0";
  return sign + int + (frac ? "." + frac : "");
}

// Length or percentage for SVG sizing attributes (width="100%", height="240").
boundedNumber.rule = RULES.VAL_NUMBER;

function lengthOrPercent(v) {
  v = v.trim();
  if (v.endsWith("%")) {
    const n = boundedNumber(v.slice(0, -1));
    return n === null ? null : n + "%";
  }
  return boundedNumber(v);
}

lengthOrPercent.rule = RULES.VAL_NUMBER;

function boundedInt(min, max) {
  return withRule(RULES.VAL_NUMBER, (v) => {
    v = v.trim();
    if (!/^-?\d+$/.test(v) || v.replace("-", "").length > 15) return null;
    const n = Number(v);
    if (n < min || n > max) return null;
    return String(n);
  });
}

function oneOf(...values) {
  const set = new Set(values);
  return withRule(RULES.VAL_KEYWORD, (v) => (set.has(v.trim()) ? v.trim() : null));
}

function fixed(value) {
  return withRule(RULES.VAL_KEYWORD, () => value);
}

// Text-valued attribute: printable text, bounded, no control or bidi chars.
function plainText(v) {
  if (v.length > LIMITS.maxAttrValueLength) return null;
  return cleanText(v);
}

plainText.rule = RULES.TEXT_CONTROL_BIDI;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Bidi overrides and isolates can make displayed text misleading. Strip them.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;

export function cleanText(s) {
  return s.replace(CONTROL_RE, "").replace(BIDI_RE, "");
}

// Identifiers for data-action and similar bindings.
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function ident(v) {
  v = v.trim();
  return IDENT_RE.test(v) ? v : null;
}
ident.rule = RULES.VAL_KEYWORD;

// Element ids are accepted only in a restricted form and are always emitted
// with a fixed prefix so generated ids cannot collide with host or frame ids
// or clobber named properties the frame code relies on.
export const ID_PREFIX = "g-";
function idValue(v) {
  v = v.trim();
  // Idempotent: an already-prefixed id is accepted unchanged so validated
  // output is a fixed point of the policy.
  if (v.startsWith(ID_PREFIX) && IDENT_RE.test(v.slice(ID_PREFIX.length))) return v;
  return IDENT_RE.test(v) ? ID_PREFIX + v : null;
}
idValue.rule = RULES.CLOBBER_ID_PREFIX;
function idRefList(v) {
  const parts = v.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 8) return null;
  const out = [];
  for (const p of parts) {
    const id = idValue(p);
    if (id === null) return null;
    out.push(id);
  }
  return out.join(" ");
}
idRefList.rule = RULES.CLOBBER_ID_PREFIX;

// Class names must come from the bundled stylesheet. The allowlist is
// injected so the host and the frame share one list.
let classAllowlist = new Set();
export function setClassAllowlist(names) {
  classAllowlist = new Set(names);
}
function classValue(v) {
  const parts = v.trim().split(/\s+/).filter(Boolean);
  const kept = parts.filter((p) => classAllowlist.has(p));
  if (kept.length === 0) return null;
  return kept.join(" ");
}
classValue.rule = RULES.STYLE_CLASS;

// Colors: named, hex, rgb()/rgba() with integer or percent components.
const NAMED_COLORS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple",
  "fuchsia", "green", "lime", "olive", "yellow", "navy", "blue", "teal",
  "aqua", "orange", "none", "currentcolor", "transparent",
]);
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)\s*(?:,\s*(0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/;
function color(v) {
  v = v.trim();
  const lower = asciiLower(v);
  if (NAMED_COLORS.has(lower)) return lower === "currentcolor" ? "currentColor" : lower;
  if (HEX_RE.test(v)) return v; // case preserved; CSS hex is case-insensitive
  if (RGB_RE.test(lower)) return lower;
  return null;
}
color.rule = RULES.VAL_COLOR;

// Opacity and similar unit-interval values.
function unitInterval(v) {
  const n = boundedNumber(v);
  if (n === null) return null;
  const f = Number(n);
  return f >= 0 && f <= 1 ? n : null;
}
unitInterval.rule = RULES.VAL_NUMBER;

// Non-negative bounded number (stroke widths, font sizes, radii).
function nonNegative(v) {
  const n = boundedNumber(v);
  if (n === null || Number(n) < 0) return null;
  return n;
}
nonNegative.rule = RULES.VAL_NUMBER;

// Whitespace or comma separated bounded numbers.
function numberList(maxCount) {
  return withRule(RULES.VAL_NUMBER, (v) => {
    const parts = v.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0 || parts.length > maxCount) return null;
    const out = [];
    for (const p of parts) {
      const n = boundedNumber(p);
      if (n === null) return null;
      out.push(n);
    }
    return out.join(" ");
  });
}

// SVG path data: a strict sequential tokenizer. Every character must be
// whitespace, a comma, a command letter, or part of a number token that
// canonicalizes. Anything else rejects the whole value. Mirrors Guard.V.pathData.
const PATH_COMMANDS = new Set("MmZzLlHhVvCcSsQqTtAa");
const PATH_NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)/;
function pathData(v) {
  v = v.trim();
  if (v.length > LIMITS.maxAttrValueLength * 10) return null;
  const out = [];
  let numbers = 0;
  let i = 0;
  while (i < v.length) {
    const c = v[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (PATH_COMMANDS.has(c)) { out.push(c); i++; continue; }
    const m = PATH_NUMBER_RE.exec(v.slice(i));
    if (!m) return null;
    if (++numbers > LIMITS.maxPathNumbers) return null;
    const n = boundedNumber(m[0]);
    if (n === null) return null;
    out.push(n);
    i += m[0].length;
  }
  if (out.length === 0 || !/^[Mm]$/.test(out[0])) return null;
  return out.join(" ");
}
pathData.rule = RULES.VAL_PATH;

// transform="translate(x y) scale(s) rotate(a cx cy)" with bounded numbers.
const TRANSFORM_ARITY = {
  translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1, 1], skewY: [1, 1], matrix: [6, 6],
};
// Sequential parser: name, optional whitespace, "(", args without nested
// parentheses, ")". At most 8 functions. Mirrors Guard.V.transform.
function transform(v) {
  v = v.trim();
  if (v.length > LIMITS.maxAttrValueLength || v.length === 0) return null;
  const out = [];
  let i = 0;
  for (;;) {
    while (i < v.length && /\s/.test(v[i])) i++;
    if (i >= v.length) break;
    if (out.length + 1 > 8) return null;
    const name = /^[A-Za-z]*/.exec(v.slice(i))[0];
    if (!Object.prototype.hasOwnProperty.call(TRANSFORM_ARITY, name)) return null;
    i += name.length;
    while (i < v.length && /\s/.test(v[i])) i++;
    if (v[i] !== "(") return null;
    i++;
    const close = v.indexOf(")", i);
    if (close === -1) return null;
    const args = v.slice(i, close);
    if (args.includes("(")) return null;
    i = close + 1;
    const nums = numberList(6)(args);
    if (nums === null) return null;
    const arity = nums.split(" ").length;
    const [lo, hi] = TRANSFORM_ARITY[name];
    if (arity < lo || arity > hi) return null;
    out.push(`${name}(${nums})`);
  }
  return out.length ? out.join(" ") : null;
}
transform.rule = RULES.VAL_TRANSFORM;

function viewBox(v) {
  const nums = numberList(4)(v);
  if (nums === null || nums.split(" ").length !== 4) return null;
  const [, , w, h] = nums.split(" ").map(Number);
  return w > 0 && h > 0 ? nums : null;
}
viewBox.rule = RULES.VAL_NUMBER;

// ---------------------------------------------------------------------------
// Attribute tables and limits are generated from rules/policy.json.
// The descriptor interpreter keeps JS algorithms independent of Lean.
function resolveValidator([kind, a, b]) {
  const simple = {
    num: boundedNumber, nonNeg: nonNegative, unit: unitInterval,
    lenPct: lengthOrPercent, path: pathData, transform, viewBox, color,
    text: plainText, ident, id: idValue, idRefs: idRefList, cls: classValue,
    lang: withRule(RULES.VAL_KEYWORD, v => (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v.trim()) ? v.trim() : null)),
  };
  if (Object.hasOwn(simple, kind)) return simple[kind];
  if (kind === "int") return boundedInt(a, b);
  if (kind === "numList") return numberList(a);
  if (kind === "oneOf") return oneOf(...a);
  if (kind === "fixed") return fixed(a);
  if (kind === "tagged") return withRule(a, resolveValidator(b));
  throw new Error(`unknown validator descriptor: ${kind}`);
}

const TABLES = createPolicyTables(resolveValidator);
export const { HTML_ELEMENTS, SVG_ELEMENTS, HTML_UNWRAP, HTML_DROP_RULES, SVG_DROP_RULES, ATTR_DROP_RULES } = TABLES;
const { HTML_GLOBAL, SVG_GLOBAL, HTML_FORCED, SVG_TEXT_ONLY } = TABLES;

export function dropRuleFor(name) {
  return ATTR_DROP_RULES.get(name) ?? (name.includes(":") ? RULES.ATTR_NAMESPACED : name.startsWith("on") ? RULES.EXEC_HANDLER : RULES.ATTR_ALLOWLIST);
}
const SVG_ATTR_CANONICAL = new Map();
for (const table of [SVG_GLOBAL, ...Object.values(SVG_ELEMENTS)]) {
  if (table) for (const name of Object.keys(table)) SVG_ATTR_CANONICAL.set(asciiLower(name), name);
}

// ---------------------------------------------------------------------------
// The checker.

function normalizeTree(rawRoot) {
  const changes = [];
  const counters = { nodes: 0, totalText: 0 };
  const reasons = [];

  const children = checkChildren(rawRoot.children ?? [], "html", 0, [], changes, counters, reasons, false);
  if (reasons.length) return { status: "rejected", reasons };
  return { status: "validated", tree: root(children), changes };
}

/** Internal proposal builder. A proposal is not permission to render. */
export function buildCandidate(rawRoot) {
  const result = normalizeTree(rawRoot);
  return result.status === "validated" ? { ...result, status: "proposed" } : result;
}

// Reference/test-only acceptance; not used by the production Worker.
// Mirrors Lean's explicit output predicate. It verifies a candidate without
// repairing it; the normalizer above is not trusted to satisfy it implicitly.
export function policyOk(tree) {
  let nodes = 0, totalText = 0;
  function visit(children, parentNs, depth, textOnly) {
    return children.every(node => {
      if (++nodes > LIMITS.maxNodes) return false;
      if (node.kind === "text") {
        totalText += node.text.length;
        return node.text.length > 0 && node.text === cleanText(node.text) &&
          node.text.length <= LIMITS.maxTextLength && totalText <= LIMITS.maxTotalText;
      }
      if (textOnly || depth + 1 > LIMITS.maxDepth) return false;
      const tables = node.ns === "html" ? HTML_ELEMENTS : node.ns === "svg" ? SVG_ELEMENTS : null;
      if (!tables || !Object.hasOwn(tables, node.tag)) return false;
      if (node.ns === "html" ? parentNs !== "html" : node.tag !== "svg" && parentNs !== "svg") return false;
      const table = tables[node.tag] ?? {};
      const global = node.ns === "html" ? HTML_GLOBAL : SVG_GLOBAL;
      if (node.attrs.length > LIMITS.maxAttrs) return false;
      for (const [name, value] of node.attrs) {
        if (name.includes(":") || name.startsWith("on")) return false;
        const validator = Object.hasOwn(table, name) ? table[name] : Object.hasOwn(global, name) ? global[name] : null;
        if (!validator || validator(value) !== value) return false;
      }
      if (node.ns === "html") {
        const attrs = new Map(node.attrs);
        for (const [name, value] of HTML_FORCED[node.tag] ?? []) if (attrs.get(name) !== value) return false;
        if (node.tag === "input" && !attrs.has("type")) return false;
      }
      return visit(node.children, node.ns, depth + 1, node.ns === "svg" && SVG_TEXT_ONLY.has(node.tag));
    });
  }
  return visit(tree.children, "html", 0, false);
}

export function checkTree(rawRoot) {
  // RULES.CHECK_ACCEPTANCE: both postconditions must hold before release.
  const candidate = normalizeTree(rawRoot);
  if (candidate.status !== "validated") return candidate;
  if (!policyOk(candidate.tree)) return { status: "rejected", reasons: [{ code: "output-policy" }] };
  const replay = normalizeTree(candidate.tree);
  if (replay.status !== "validated" || replay.changes.length !== 0 || JSON.stringify(replay.tree) !== JSON.stringify(candidate.tree)) {
    return { status: "rejected", reasons: [{ code: "non-canonical-output" }] };
  }
  return candidate;
}

// Traversal is iterative with an explicit work stack. A chain of unwrapped
// elements does not increase output depth (LIMITS.maxDepth), so that guard
// cannot bound traversal work; recursion here used to grow one JavaScript
// frame per input level and a hand-built deep tree passed straight to
// checkTree() could overflow the stack. Accept/reject decisions, emitted
// trees and change records are unchanged.
//
// LIMITS.maxTraversalDepth is a separate structural ceiling that counts every
// descent, including unwrapped elements, and rejects with "traversal-depth".
// The Lean checker applies the identical ceiling at the identical point, so
// the two engines still agree and the differential exercises it directly.
// It is above the preprocessing raw-depth bound and far above the frame's
// tree-shape bound, so no HTML-derived or frame-delivered tree can reach it;
// it is reachable only by calling checkTree() directly with a hand-built raw
// tree deeper than that.
function checkChildren(rawChildren, parentNs, depth, path, changes, counters, reasons, textOnly) {
  const rootOut = [];
  const stack = [{
    list: Array.isArray(rawChildren) ? rawChildren : [],
    parentNs, depth, sdepth: 0, path, textOnly, out: rootOut, index: 0, finish: null,
  }];
  // One descent into a child list, mirroring the former recursive call.
  const descend = (frame, list, childNs, childDepth, here, childTextOnly, out, finish) => {
    if (frame.sdepth + 1 > LIMITS.maxTraversalDepth) {
      reasons.push({ code: "traversal-depth", path: here });
      if (finish) finish(out);
      return;
    }
    stack.push({
      list: Array.isArray(list) ? list : [],
      parentNs: childNs, depth: childDepth, sdepth: frame.sdepth + 1,
      path: here, textOnly: childTextOnly, out, index: 0, finish,
    });
  };

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.list.length) {
      stack.pop();
      // The element wrapping this list is emitted when the list finishes,
      // exactly where the recursive version pushed it.
      if (frame.finish) frame.finish(frame.out);
      continue;
    }
    const raw = frame.list[frame.index];
    const here = frame.path.concat(frame.index);
    frame.index++;
    if (reasons.length) continue;
    if (raw == null || typeof raw !== "object") continue;

    if (raw.kind === "text") {
      const s = typeof raw.text === "string" ? cleanText(raw.text) : "";
      if (s.length === 0) continue;
      if (s.length > LIMITS.maxTextLength) {
        reasons.push({ code: "text-too-long", path: here });
        continue;
      }
      counters.totalText += s.length;
      if (counters.totalText > LIMITS.maxTotalText) {
        reasons.push({ code: "total-text-too-long", path: here });
        continue;
      }
      counters.nodes++;
      if (counters.nodes > LIMITS.maxNodes) {
        reasons.push({ code: "too-many-nodes", path: here });
        continue;
      }
      frame.out.push(text(s));
      continue;
    }

    if (raw.kind === "comment" || raw.kind === "doctype") {
      changes.push({ kind: "removed-node", what: raw.kind, path: here, rule: RULES.STRUCT_NON_ELEMENT });
      continue;
    }

    if (raw.kind !== "el" || typeof raw.tag !== "string") {
      changes.push({ kind: "removed-node", what: "unknown", path: here, rule: RULES.STRUCT_NON_ELEMENT });
      continue;
    }

    if (frame.textOnly) {
      changes.push({ kind: "removed-element", tag: raw.tag, path: here, why: "text-only-context", rule: RULES.NS_POSITION });
      continue;
    }

    const tag = asciiLower(raw.tag);
    const ns = raw.ns === "svg" ? "svg" : raw.ns === "html" ? "html" : "other";

    if (frame.depth + 1 > LIMITS.maxDepth) {
      reasons.push({ code: "too-deep", path: here });
      continue;
    }

    let table = null;
    if (ns === "html" && frame.parentNs === "html") {
      if (Object.prototype.hasOwnProperty.call(HTML_ELEMENTS, tag)) table = HTML_ELEMENTS[tag];
      else if (HTML_UNWRAP.has(tag)) {
        changes.push({ kind: "unwrapped-element", tag, path: here, rule: HTML_UNWRAP.get(tag) });
        // The children take this element's place in the same output list.
        descend(frame, raw.children, frame.parentNs, frame.depth, here, false, frame.out, null);
        continue;
      } else {
        changes.push({ kind: "removed-element", tag, path: here, rule: HTML_DROP_RULES.get(tag) ?? RULES.STRUCT_ELEMENT_ALLOWLIST });
        continue;
      }
    } else if (ns === "svg" && (tag === "svg" || frame.parentNs === "svg")) {
      if (Object.prototype.hasOwnProperty.call(SVG_ELEMENTS, tag)) table = SVG_ELEMENTS[tag];
      else {
        changes.push({ kind: "removed-element", tag, ns, path: here, rule: SVG_DROP_RULES.get(tag) ?? RULES.STRUCT_ELEMENT_ALLOWLIST });
        continue;
      }
    } else {
      // Wrong namespace for this position (HTML inside SVG via an integration
      // point, MathML anywhere, SVG element outside an <svg> root).
      changes.push({ kind: "removed-element", tag, ns, path: here, why: "namespace", rule: ns === "other" ? RULES.NS_MATHML : RULES.NS_POSITION });
      continue;
    }

    counters.nodes++;
    if (counters.nodes > LIMITS.maxNodes) {
      reasons.push({ code: "too-many-nodes", path: here });
      continue;
    }

    const attrs = checkAttrs(raw.attrs, ns, tag, table, here, changes);
    const childTextOnly = ns === "svg" && SVG_TEXT_ONLY.has(tag);
    const out = frame.out;
    const kids = [];
    descend(frame, raw.children, ns, frame.depth + 1, here, childTextOnly, kids, (k) => out.push(el(ns, tag, attrs, k)));
  }
  return rootOut;
}

function checkAttrs(rawAttrs, ns, tag, table, path, changes) {
  const global = ns === "html" ? HTML_GLOBAL : SVG_GLOBAL;
  const seen = new Map();
  const list = Array.isArray(rawAttrs) ? rawAttrs : [];
  let count = 0;
  for (const pair of list) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    const lower = asciiLower(pair[0]);
    const name = ns === "svg" ? (SVG_ATTR_CANONICAL.get(lower) ?? lower) : lower;
    const value = pair[1];
    if (++count > LIMITS.maxAttrs) {
      changes.push({ kind: "removed-attribute", tag, name, path, why: "too-many", rule: RULES.LIMIT_ATTRS });
      continue;
    }
    // Prefixed or namespaced attributes (xlink:href, xmlns:foo) are never allowed.
    if (name.includes(":") || name.startsWith("on")) {
      changes.push({ kind: "removed-attribute", tag, name, path, rule: dropRuleFor(name) });
      continue;
    }
    let validator = null;
    if (table && Object.prototype.hasOwnProperty.call(table, name)) validator = table[name];
    else if (Object.prototype.hasOwnProperty.call(global, name)) validator = global[name];
    if (!validator) {
      changes.push({ kind: "removed-attribute", tag, name, path, rule: dropRuleFor(name) });
      continue;
    }
    if (value.length > LIMITS.maxAttrValueLength * 10) {
      changes.push({ kind: "removed-attribute", tag, name, path, why: "too-long", rule: RULES.LIMIT_ATTRS });
      continue;
    }
    const canonical = validator(value);
    if (canonical === null) {
      changes.push({ kind: "removed-attribute", tag, name, path, why: "value", rule: validator.rule });
      continue;
    }
    if (canonical !== value) changes.push({ kind: "rewrote-attribute", tag, name, path, rule: validator.rule });
    if (!seen.has(name)) seen.set(name, canonical);
  }
  if (ns === "html" && HTML_FORCED[tag]) {
    for (const [name, value] of HTML_FORCED[tag]) {
      if (!seen.has(name)) seen.set(name, value);
    }
  }
  // Inputs need a type; default to text if none survived.
  if (ns === "html" && tag === "input" && !seen.has("type")) seen.set("type", "text");
  return Array.from(seen.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Is this tree already in canonical validated form? Used by the frame: it
// re-runs the policy on every incoming tree and requires a fixed point with
// no changes, so a tree that was not produced by this policy is refused.
export function isValidated(tree) {
  const result = checkTree(tree);
  if (result.status !== "validated") return false;
  if (result.changes.length !== 0) return false;
  return JSON.stringify(result.tree) === JSON.stringify(tree);
}
