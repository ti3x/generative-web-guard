// The editable policy is data in rules/policy.json. Validator algorithms stay
// independently implemented in JS and Lean and are compared behaviorally.
//
// rules/capabilities.json is a separate, reviewed capability kernel: closed
// element/attribute identities, the widest value grammar reviewed for each
// attribute in its context, mandatory controls, namespace constraints and
// absolute resource ceilings. A profile may only *restrict* that kernel. This
// generator enforces containment before it emits any table, so an unsafe
// profile fails `npm run gen:policy` and `npm run check:policy` whether or not
// a matching exploit exists in any corpus.
//
// Enforcement here is a build-time schema/containment check. It does not make
// the generator, or an arbitrarily edited capability inventory, proved safe:
// widening the inventory is a kernel change requiring security review.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog, constName } from "./gen-rules.mjs";

const root = new URL("../", import.meta.url);
const tableKeys = ["htmlGlobal", "svgGlobal", "htmlElements", "svgElements", "htmlForced", "htmlUnwrap", "htmlDropRules", "svgDropRules", "attrDropRules", "svgTextOnly"];
const limitKeys = ["maxNodes", "maxDepth", "maxTextLength", "maxTotalText", "maxAttrs", "maxAttrValueLength", "maxPathNumbers", "maxPointsNumbers", "maxNumberMagnitude", "maxTraversalDepth"];
const q = JSON.stringify;
const leanString = s => q(s); // Schema strings are restricted to printable ASCII below.

// ---------------------------------------------------------------------------
// The reviewed capability kernel.

let capsCache = null;

export function loadCapabilities() {
  if (!capsCache) {
    const caps = JSON.parse(readFileSync(new URL("rules/capabilities.json", root), "utf8"));
    validateCapabilities(caps);
    capsCache = caps;
  }
  return capsCache;
}

const families = () => new Set(loadCapabilities().families.plain);

function makeChecks(what) {
  const fail = msg => { throw new Error(`${what}: ${msg}`); };
  const string = v => { if (typeof v !== "string" || /[^\x20-\x7e]/.test(v)) fail("expected printable ASCII string"); return v; };
  return { fail, string };
}

// A validator descriptor. `plain` names a closed family; the parameterized
// forms carry their own bounds; `tagged` only relabels the cited rule.
function makeDescriptor({ fail, string }, plain, { rules = null, allowTagged = true } = {}) {
  const descriptor = d => {
    if (!Array.isArray(d)) fail("validator must be a descriptor array");
    const [kind, ...args] = d;
    if (plain.has(kind) && args.length === 0) return;
    if (kind === "tagged" && allowTagged && args.length === 2 && rules?.has(args[0])) return descriptor(args[1]);
    if (kind === "oneOf" && args.length === 1 && Array.isArray(args[0]) && args[0].length) { args[0].forEach(string); return; }
    if (kind === "fixed" && args.length === 1) { string(args[0]); return; }
    if (kind === "numList" && args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0) return;
    if (kind === "int" && args.length === 2 && args.every(Number.isSafeInteger) && args[0] <= args[1]) return;
    fail(`invalid validator ${q(d)}`);
  };
  return descriptor;
}

const untag = d => (d[0] === "tagged" ? untag(d[2]) : d);

/**
 * Is `sub` a restriction of the kernel descriptor `sup`? Decidable by
 * inspection only: enums restrict by set inclusion, numeric ranges by interval
 * inclusion, list lengths by a smaller bound, and every custom grammar
 * (colors, paths, transforms, ids, plain text, ...) requires *exact identity*.
 * There is deliberately no general implication solver, no regular expression
 * and no callback, so a profile can never trade one grammar for another --
 * paint cannot become text and a bounded number cannot become a free string.
 * Rule tags are transparent: they change the cited rule id, not the grammar.
 */
export function restricts(sub, sup) {
  const a = untag(sub), b = untag(sup);
  if (b[0] === "oneOf") {
    if (a[0] === "oneOf") return a[1].length > 0 && a[1].every(v => b[1].includes(v));
    // A single fixed value is the smallest enum. Require a canonical (already
    // trimmed) value so that the enum validator returns it unchanged too.
    if (a[0] === "fixed") return b[1].includes(a[1]) && a[1] === a[1].trim();
    return false;
  }
  if (b[0] === "fixed") return a[0] === "fixed" && a[1] === b[1];
  if (b[0] === "int") return a[0] === "int" && b[1] <= a[1] && a[1] <= a[2] && a[2] <= b[2];
  if (b[0] === "numList") return a[0] === "numList" && a[1] > 0 && a[1] <= b[1];
  return a.length === 1 && b.length === 1 && a[0] === b[0];
}

const ATTR_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;

export function validateCapabilities(c) {
  const { fail, string } = makeChecks("capability schema");
  const known = new Set(["capabilityVersion", "rules", "meaning", "reviewedAt", "reviewScope", "families", "namespaces", "ceilings", "attributes", "elements", "forcedAttributes", "requiredAttributes", "textOnlyElements", "unwrappableElements", "excludedElements", "excludedAttributes"]);
  for (const k of Object.keys(c)) if (!known.has(k)) fail(`unknown field ${k}`);
  for (const k of known) if (!(k in c)) fail(`missing field ${k}`);
  if (!Number.isSafeInteger(c.capabilityVersion) || c.capabilityVersion < 1) fail("capabilityVersion must be a positive integer");
  const catalogRules = new Set(loadCatalog().rules.map(r => r.id));
  if (!Array.isArray(c.rules) || !c.rules.length) fail("rules must name the catalog rules this kernel implements");
  for (const id of c.rules.map(string)) if (!catalogRules.has(id)) fail(`unknown catalog rule ${id}`);
  // The inventory's *meaning* is versioned, not only its contents.
  for (const k of ["meaning", "reviewedAt", "reviewScope"]) if (typeof c[k] !== "string" || c[k].length < 8) fail(`${k} must describe the reviewed scope`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.reviewedAt)) fail("reviewedAt must be an ISO date");
  for (const k of ["plain", "parameterized", "wrapper"]) {
    if (!Array.isArray(c.families[k]) || !c.families[k].length) fail(`families.${k} must be a non-empty list`);
    c.families[k].forEach(string);
  }
  const plain = new Set(c.families.plain);
  if (q(c.families.parameterized) !== q(["int", "numList", "oneOf", "fixed"])) fail("parameterized families are fixed by this generator");
  if (q(c.families.wrapper) !== q(["tagged"])) fail("the only descriptor wrapper is tagged");
  if (q(c.namespaces) !== q(["html", "svg"])) fail("namespaces are fixed: html and svg");
  if (q(Object.keys(c.ceilings)) !== q(limitKeys)) fail(`ceilings must name exactly ${limitKeys.join(", ")}`);
  for (const k of limitKeys) if (!Number.isSafeInteger(c.ceilings[k]) || c.ceilings[k] <= 0) fail(`invalid ceiling ${k}`);

  // The kernel records maximal grammars, so rule tags are not allowed here.
  const descriptor = makeDescriptor({ fail, string }, plain, { allowTagged: false });
  const attrTable = (t, label) => {
    if (!t || Array.isArray(t) || typeof t !== "object") fail(`${label} must be an object`);
    for (const [name, d] of Object.entries(t)) {
      if (!ATTR_NAME.test(name) || name.startsWith("on")) fail(`invalid capability attribute ${label}.${name}`);
      descriptor(d);
    }
  };
  if (q(Object.keys(c.attributes)) !== q(["shared", "html", "svg"])) fail("attributes must name shared, html and svg");
  for (const [k, t] of Object.entries(c.attributes)) attrTable(t, `attributes.${k}`);
  for (const name of Object.keys(c.attributes.shared)) {
    for (const ns of ["html", "svg"]) if (Object.hasOwn(c.attributes[ns], name)) fail(`attribute ${name} is both shared and ${ns}-specific`);
  }
  if (q(Object.keys(c.elements)) !== q(["html", "svg"])) fail("elements must name html and svg");
  for (const [ns, table] of Object.entries(c.elements)) {
    for (const [tag, t] of Object.entries(table)) {
      if (!TAG_NAME.test(tag)) fail(`invalid capability element ${ns}:${tag}`);
      attrTable(t, `elements.${ns}.${tag}`);
    }
  }
  const attrAllowedOn = (ns, tag, name) =>
    Object.hasOwn(c.elements[ns][tag] ?? {}, name) || Object.hasOwn(c.attributes[ns], name) || Object.hasOwn(c.attributes.shared, name);
  for (const [tag, pairs] of Object.entries(c.forcedAttributes)) {
    if (!Object.hasOwn(c.elements.html, tag)) fail(`forcedAttributes names unknown element ${tag}`);
    if (!Array.isArray(pairs) || !pairs.length) fail(`forcedAttributes.${tag} must be a non-empty list`);
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) fail(`forcedAttributes.${tag} must hold name/value pairs`);
      const [name, value] = pair.map(string);
      if (!attrAllowedOn("html", tag, name)) fail(`forced attribute ${tag}.${name} is not in the inventory`);
      const d = c.elements.html[tag][name] ?? c.attributes.html[name] ?? c.attributes.shared[name];
      // A mandatory control must be expressible in the attribute's own grammar.
      const ok = d[0] === "fixed" ? d[1] === value : d[0] === "oneOf" ? d[1].includes(value) : false;
      if (!ok) fail(`forced value ${tag}.${name}=${q(value)} is not in that attribute's kernel grammar`);
    }
  }
  for (const [tag, names] of Object.entries(c.requiredAttributes)) {
    if (!Object.hasOwn(c.elements.html, tag)) fail(`requiredAttributes names unknown element ${tag}`);
    if (!Array.isArray(names) || !names.length) fail(`requiredAttributes.${tag} must be a non-empty list`);
    for (const name of names.map(string)) if (!attrAllowedOn("html", tag, name)) fail(`required attribute ${tag}.${name} is not in the inventory`);
  }
  if (q(Object.keys(c.textOnlyElements)) !== q(["svg"])) fail("textOnlyElements only constrains svg");
  for (const tag of c.textOnlyElements.svg) if (!Object.hasOwn(c.elements.svg, tag)) fail(`textOnlyElements names unknown svg element ${tag}`);
  if (q(Object.keys(c.unwrappableElements)) !== q(["html"])) fail("unwrappableElements only applies to html");
  for (const tag of c.unwrappableElements.html) {
    if (!TAG_NAME.test(tag)) fail(`invalid unwrappable element ${tag}`);
    if (Object.hasOwn(c.elements.html, tag)) fail(`${tag} cannot be both permitted and unwrappable`);
  }

  // Exclusions are an independent statement of what must never be permitted.
  // They must contradict nothing in the inventory, so an inventory edit that
  // adds an excluded identity fails the kernel's own consistency check.
  if (q(Object.keys(c.excludedElements)) !== q(["html", "svg"])) fail("excludedElements must name html and svg");
  const dups = list => list.filter((n, i) => list.indexOf(n) !== i);
  for (const [ns, list] of Object.entries(c.excludedElements)) {
    if (dups(list).length) fail(`duplicate excluded ${ns} element ${dups(list)[0]}`);
    for (const tag of list.map(string)) if (Object.hasOwn(c.elements[ns], tag)) fail(`${ns} element ${tag} is both permitted and excluded`);
  }
  if (dups(c.excludedAttributes).length) fail(`duplicate excluded attribute ${dups(c.excludedAttributes)[0]}`);
  for (const name of c.excludedAttributes.map(string)) {
    const where = [];
    for (const [k, t] of Object.entries(c.attributes)) if (Object.hasOwn(t, name)) where.push(`attributes.${k}`);
    for (const [ns, table] of Object.entries(c.elements)) for (const [tag, t] of Object.entries(table)) if (Object.hasOwn(t, name)) where.push(`${ns}:${tag}`);
    if (where.length) fail(`attribute ${name} is both permitted (${where.join(", ")}) and excluded`);
  }
}

// ---------------------------------------------------------------------------
// Profile validation: schema, then containment in the capability kernel.

export function validatePolicy(p, caps = loadCapabilities()) {
  const rules = new Set(loadCatalog().rules.map(r => r.id));
  const { fail, string } = makeChecks("policy schema");
  const descriptor = makeDescriptor({ fail, string }, new Set(caps.families.plain), { rules });
  const attrs = t => {
    if (!t || Array.isArray(t) || typeof t !== "object") fail("attribute table must be an object");
    for (const [name, d] of Object.entries(t)) {
      if (!ATTR_NAME.test(name) || name.startsWith("on")) fail(`invalid allowed attribute ${name}`);
      descriptor(d);
    }
  };
  if (p.version !== 1 || Object.keys(p).some(k => !["version", "limits", "sharedGlobal", ...tableKeys].includes(k))) fail("unknown schema version or field");
  if (!p.limits || Object.keys(p.limits).length !== limitKeys.length) fail("unexpected structural limits");
  for (const k of limitKeys) if (!Number.isSafeInteger(p.limits[k]) || p.limits[k] <= 0) fail(`invalid limit ${k}`);
  attrs(p.sharedGlobal); attrs(p.htmlGlobal); attrs(p.svgGlobal);
  for (const k of Object.keys(p.sharedGlobal)) if (Object.hasOwn(p.htmlGlobal, k) || Object.hasOwn(p.svgGlobal, k)) fail(`duplicate shared attribute ${k}`);
  for (const key of ["htmlElements", "svgElements"]) for (const [tag, t] of Object.entries(p[key])) {
    if (!/^[a-z][a-z0-9]*$/.test(tag)) fail(`invalid tag ${tag}`);
    if (t !== null) attrs(t);
  }
  for (const [tag, pairs] of Object.entries(p.htmlForced)) {
    if (!Object.hasOwn(p.htmlElements, tag) || !Array.isArray(pairs)) fail(`invalid forced element ${tag}`);
    for (const [name, value] of pairs) {
      string(name); string(value);
      if (!Object.hasOwn(p.htmlElements[tag] ?? {}, name) && !Object.hasOwn(p.htmlGlobal, name) && !Object.hasOwn(p.sharedGlobal, name)) fail(`forced attribute ${name} is not allowed`);
    }
  }
  for (const key of ["htmlUnwrap", "htmlDropRules", "svgDropRules", "attrDropRules"]) {
    const names = new Set();
    for (const pair of p[key]) {
      if (!Array.isArray(pair) || pair.length !== 2 || !rules.has(pair[1]) || names.has(pair[0])) fail(`invalid ${key} pair`);
      string(pair[0]); names.add(pair[0]);
    }
  }
  for (const name of p.svgTextOnly) if (!Object.hasOwn(p.svgElements, name)) fail(`unknown text-only SVG tag ${name}`);

  validateProfileCapabilities(p, caps, fail);

  // Element permission and removal labels must stay disjoint, so that an
  // allowlist entry can never be mistaken for a revocation. Checked after
  // containment so that a forbidden element reports the capability failure.
  for (const [tag] of p.htmlUnwrap) if (Object.hasOwn(p.htmlElements, tag)) fail(`${tag} is both allowed and unwrapped`);
  for (const [ns, key] of [["html", "htmlDropRules"], ["svg", "svgDropRules"]]) {
    for (const [tag] of p[key]) if (Object.hasOwn(p[`${ns}Elements`], tag)) fail(`${ns} element ${tag} is both allowed and drop-labelled`);
  }
}

/**
 * Containment: the profile may only restrict the kernel. Every failure below
 * is reachable by editing rules/policy.json alone, independently of the
 * red-team corpus or any other test input.
 */
export function validateProfileCapabilities(p, caps, fail) {
  const grammarFor = (ns, tag, name) =>
    (tag === null ? undefined : caps.elements[ns][tag]?.[name]) ?? caps.attributes[ns][name] ?? caps.attributes.shared[name];

  for (const k of limitKeys) {
    if (p.limits[k] > caps.ceilings[k]) fail(`limit ${k}=${p.limits[k]} exceeds the kernel ceiling ${caps.ceilings[k]}`);
  }

  const checkTable = (table, ns, tag, label) => {
    for (const [name, d] of Object.entries(table ?? {})) {
      if (caps.excludedAttributes.includes(name)) fail(`${label} attribute ${name} is excluded by the capability kernel`);
      const sup = tag === null && ns === null ? caps.attributes.shared[name] : grammarFor(ns, tag, name);
      if (!sup) fail(`${label} attribute ${name} is not in the capability inventory`);
      if (!restricts(d, sup)) fail(`${label} attribute ${name}: ${q(untag(d))} does not restrict the kernel grammar ${q(sup)}`);
    }
  };
  checkTable(p.sharedGlobal, null, null, "shared global");
  checkTable(p.htmlGlobal, "html", null, "html global");
  checkTable(p.svgGlobal, "svg", null, "svg global");

  for (const ns of ["html", "svg"]) {
    for (const [tag, t] of Object.entries(p[`${ns}Elements`])) {
      if (caps.excludedElements[ns].includes(tag)) fail(`${ns} element ${tag} is excluded by the capability kernel`);
      if (!Object.hasOwn(caps.elements[ns], tag)) fail(`${ns} element ${tag} is not in the capability inventory`);
      checkTable(t, ns, tag, `${ns} ${tag}`);
    }
  }

  // Mandatory controls. Dropping the element altogether is a restriction;
  // keeping the element while weakening its controls is not.
  for (const [tag, pairs] of Object.entries(caps.forcedAttributes)) {
    if (!Object.hasOwn(p.htmlElements, tag)) continue;
    const forced = new Map(p.htmlForced[tag] ?? []);
    for (const [name, value] of pairs) {
      if (forced.get(name) !== value) fail(`html ${tag} must force ${name}=${q(value)} (found ${q(forced.get(name) ?? null)})`);
    }
  }
  for (const [tag, names] of Object.entries(caps.requiredAttributes)) {
    if (!Object.hasOwn(p.htmlElements, tag)) continue;
    for (const name of names) {
      if (!Object.hasOwn(p.htmlElements[tag] ?? {}, name) && !Object.hasOwn(p.htmlGlobal, name) && !Object.hasOwn(p.sharedGlobal, name)) {
        fail(`html ${tag} must keep the mandatory attribute ${name}`);
      }
    }
  }
  for (const tag of caps.textOnlyElements.svg) {
    if (Object.hasOwn(p.svgElements, tag) && !p.svgTextOnly.includes(tag)) fail(`svg ${tag} must remain a text-only context`);
  }
  for (const [tag] of p.htmlUnwrap) {
    if (!caps.unwrappableElements.html.includes(tag)) fail(`html ${tag} is not a reviewed unwrappable element`);
  }
}

// ---------------------------------------------------------------------------
// Rendering.

function leanVal(d) {
  const [kind, a, b] = d;
  if (families().has(kind)) return `.${kind}`;
  if (kind === "tagged") return `.tagged R.${constName(a)} (${leanVal(b)})`;
  if (kind === "oneOf") return `.oneOf [${a.map(leanString).join(", ")}]`;
  if (kind === "fixed") return `.fixed ${leanString(a)}`;
  if (kind === "int") return `.int (${a}) (${b})`;
  return `.numList ${a}`;
}
const leanAttrs = t => `[${Object.entries(t ?? {}).map(([n, d]) => `(${leanString(n)}, ${leanVal(d)})`).join(", ")}]`;
const leanPairs = ps => `[${ps.map(([n, r]) => `(${leanString(n)}, R.${constName(r)})`).join(", ")}]`;
const leanStrings = ss => `[${ss.map(leanString).join(", ")}]`;
const leanHeader = "/- GENERATED by scripts/gen-policy.mjs from rules/policy.json. Do not edit. -/\n";
const capHeader = "/- GENERATED by scripts/gen-policy.mjs from rules/capabilities.json. Do not edit. -/\n";
const jsNames = { htmlGlobal: "HTML_GLOBAL", svgGlobal: "SVG_GLOBAL", htmlElements: "HTML_ELEMENTS", svgElements: "SVG_ELEMENTS", htmlForced: "HTML_FORCED", htmlUnwrap: "HTML_UNWRAP", htmlDropRules: "HTML_DROP_RULES", svgDropRules: "SVG_DROP_RULES", attrDropRules: "ATTR_DROP_RULES", svgTextOnly: "SVG_TEXT_ONLY" };

/** The capability inventory, in JavaScript and in Lean, from one source. */
export function renderCapabilities(c) {
  validateCapabilities(c);
  const outputs = new Map();
  outputs.set("src/capabilities-data.js",
    "// GENERATED by scripts/gen-policy.mjs from rules/capabilities.json. Do not edit.\n" +
    "// The reviewed capability kernel. Profiles may only restrict it; see\n" +
    "// scripts/gen-policy.mjs (validateProfileCapabilities) for the enforced relation.\n" +
    "// This inventory is not itself proved safe: widening it is a kernel change.\n" +
    'import { RULES } from "./rules.js";\n\n' +
    `export const CAPABILITY_VERSION = ${c.capabilityVersion};\n` +
    "// The catalog rules this kernel implements.\n" +
    `export const CAPABILITY_RULES = Object.freeze([${c.rules.map(id => `RULES.${constName(id)}`).join(", ")}]);\n` +
    `export const CAPABILITIES = Object.freeze(${JSON.stringify(c, null, 2)});\n`);

  const ceilings = Object.entries(c.ceilings).map(([n, v]) => `${n} := ${v}`).join(", ");
  outputs.set("lean/Guard/Policy/Capabilities.lean", capHeader +
    "import Guard.Policy.Cap\n\nnamespace Guard\n\nopen V\n\n" +
    "/-- Capability inventory version. Its meaning is recorded in\n" +
    "rules/capabilities.json and is reviewed together with browser behavior,\n" +
    "tests and proof scope. Expanding the inventory is a kernel change. -/\n" +
    `def capabilityVersion : Nat := ${c.capabilityVersion}\n\n` +
    "/-- The catalog rules this kernel implements. -/\n" +
    `def capabilityRules : List String := [${c.rules.map(id => `R.${constName(id)}`).join(", ")}]\n\n` +
    "def caps : Capabilities :=\n" +
    `  { version := ${c.capabilityVersion}\n` +
    `  , ceilings := { ${ceilings} }\n` +
    `  , sharedAttrs := ${leanAttrs(c.attributes.shared)}\n` +
    `  , htmlAttrs := ${leanAttrs(c.attributes.html)}\n` +
    `  , svgAttrs := ${leanAttrs(c.attributes.svg)}\n` +
    "  , htmlElements :=\n    [ " + Object.entries(c.elements.html).map(([tag, t]) => `(${leanString(tag)}, ${leanAttrs(t)})`).join("\n    , ") + " ]\n" +
    "  , svgElements :=\n    [ " + Object.entries(c.elements.svg).map(([tag, t]) => `(${leanString(tag)}, ${leanAttrs(t)})`).join("\n    , ") + " ]\n" +
    "  , forced :=\n    [ " + Object.entries(c.forcedAttributes).map(([tag, pairs]) => `(${leanString(tag)}, [${pairs.map(([n, v]) => `(${leanString(n)}, ${leanString(v)})`).join(", ")}])`).join("\n    , ") + " ]\n" +
    "  , requiredAttrs := [" + Object.entries(c.requiredAttributes).map(([tag, names]) => `(${leanString(tag)}, ${leanStrings(names)})`).join(", ") + "]\n" +
    `  , unwrappable := ${leanStrings(c.unwrappableElements.html)}\n` +
    `  , textOnlySvg := ${leanStrings(c.textOnlyElements.svg)}\n` +
    `  , excludedHtmlElements := ${leanStrings(c.excludedElements.html)}\n` +
    `  , excludedSvgElements := ${leanStrings(c.excludedElements.svg)}\n` +
    `  , excludedAttrs := ${leanStrings(c.excludedAttributes)} }\n\nend Guard\n`);
  return outputs;
}

export function renderPolicy(p, caps = loadCapabilities()) {
  validatePolicy(p, caps);
  p = { ...p, htmlGlobal: { ...p.sharedGlobal, ...p.htmlGlobal }, svgGlobal: { ...p.sharedGlobal, ...p.svgGlobal } };
  const outputs = renderCapabilities(caps);
  outputs.set("src/policy-data.js", "// GENERATED by scripts/gen-policy.mjs. Edit rules/policy.json.\n" +
    `export const POLICY_DATA = ${JSON.stringify(p, null, 2)};\n` +
    "export const POLICY_LIMITS = Object.freeze(POLICY_DATA.limits);\n" +
    "export function createPolicyTables(resolve) {\n" +
    "  const attrs = table => table === null ? null : Object.fromEntries(Object.entries(table).map(([n, d]) => [n, resolve(d)]));\n" +
    "  const elements = table => Object.fromEntries(Object.entries(table).map(([tag, t]) => [tag, attrs(t)]));\n" +
    "  return {\n" + tableKeys.map(k => `    ${jsNames[k]}: ${k.endsWith("Global") ? `attrs(POLICY_DATA.${k})` : k.endsWith("Elements") ? `elements(POLICY_DATA.${k})` : k === "htmlForced" ? `POLICY_DATA.${k}` : k === "svgTextOnly" ? `new Set(POLICY_DATA.${k})` : `new Map(POLICY_DATA.${k})`},`).join("\n") + "\n  };\n}\n");
  outputs.set("lean/Guard/Core/Limits.lean", leanHeader + "\nnamespace Guard\n\nstructure Limits where\n" +
    Object.entries(p.limits).map(([n,v]) => `  ${n} : Nat := ${v}`).join("\n") + "\n\ndef limits : Limits := {}\n\nend Guard\n");
  for (const [ns, file] of [["html", "Html"], ["svg", "Svg"]]) {
    let body = leanHeader + "import Guard.Policy.Val\n\nnamespace Guard\n\nopen V\n\n";
    body += `def ${ns}Global : Table :=\n  [ ` + Object.entries(p[`${ns}Global`]).map(([n,d]) => `(${leanString(n)}, ${leanVal(d)})`).join("\n  , ") + " ]\n\n";
    body += `def ${ns}Elements : List (String × Table) :=\n  [ ` + Object.entries(p[`${ns}Elements`]).map(([tag,t]) => `(${leanString(tag)}, ${leanAttrs(t)})`).join("\n  , ") + " ]\n\n";
    body += `def ${ns}DropRules : List (String × String) :=\n  ${leanPairs(p[`${ns}DropRules`])}\n\n`;
    if (ns === "html") {
      body += `def htmlUnwrap : List (String × String) :=\n  ${leanPairs(p.htmlUnwrap)}\n\n`;
      body += "def htmlForced : List (String × List (String × String)) :=\n  [ " + Object.entries(p.htmlForced).map(([tag,pairs]) => `(${leanString(tag)}, [${pairs.map(([n,v]) => `(${leanString(n)}, ${leanString(v)})`).join(", ")}])`).join("\n  , ") + " ]\n";
    } else {
      body += `def svgTextOnly : List String := [${p.svgTextOnly.map(leanString).join(", ")}]\n\n`;
      body += "def svgCanonical : List (String × String) :=\n  let all : Table := svgGlobal ++ svgElements.foldl (fun acc p => acc ++ p.2) []\n  all.map fun p => (asciiLower p.1, p.1)\n";
    }
    outputs.set(`lean/Guard/Policy/Tables/${file}.lean`, body + "\nend Guard\n");
  }
  outputs.set("lean/Guard/Policy/Tables/Attrs.lean", leanHeader + "import Guard.Rules\n\nnamespace Guard\n\n" +
    `def attrDropRules : List (String × String) :=\n  ${leanPairs(p.attrDropRules)}\n\n` +
    "def dropRuleFor (name : String) : String :=\n  match attrDropRules.lookup name with\n  | some r => r\n  | none =>\n    if name.contains ':' then R.ATTR_NAMESPACED\n    else if name.startsWith \"on\" then R.EXEC_HANDLER\n    else R.ATTR_ALLOWLIST\n\nend Guard\n");
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = JSON.parse(readFileSync(new URL("rules/policy.json", root), "utf8"));
  const caps = loadCapabilities();
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [name, content] of renderPolicy(p, caps)) {
    const file = new URL(name, root);
    if (check) {
      let current = null;
      try { current = readFileSync(file, "utf8"); } catch {}
      if (current !== content) stale.push(name);
    } else writeFileSync(file, content);
  }
  if (stale.length) throw new Error(`stale generated policy: ${stale.join(", ")}; run npm run gen:policy`);
  console.log(`policy: profile restricts capability kernel v${caps.capabilityVersion}; shared tables and limits ${check ? "current" : "generated"}`);
}
