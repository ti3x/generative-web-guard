// Step definitions for policy rules. The vocabulary is deliberately small so
// scenarios read as rule statements. Every scenario runs the JavaScript
// checker; "every engine" also runs the Lean checker (Docker) and the Wasm
// build when they are loaded (see support/hooks.js and REQUIRE_ENGINES).
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { parseHtmlToRaw } from "../../src/adapters/parse5.js";
import { firstDiff } from "../../scripts/lib/engines.mjs";

// --- helpers over the structured tree -------------------------------------

function elements(tree) {
  const out = [];
  (function walk(n) {
    if (n.kind === "el") out.push(n);
    for (const c of n.children ?? []) walk(c);
  })(tree);
  return out;
}

function textOf(tree) {
  let s = "";
  (function walk(n) {
    if (n.kind === "text") s += n.text;
    for (const c of n.children ?? []) walk(c);
  })(tree);
  return s;
}

function attrsOf(el) {
  return Object.fromEntries(el.attrs);
}

function requireValidated(world) {
  assert.ok(world.js, "no validation result; add a When step");
  assert.equal(world.js.status, "validated", `document was rejected: ${JSON.stringify(world.js.reasons)}`);
  return world.js.tree;
}

// --- Given ------------------------------------------------------------------

Given("the class allowlist is {string}", function (classes) {
  this.classes = classes.split(/\s+/).filter(Boolean);
});

Given("the generated HTML:", function (html) {
  this.html = html;
  this.raw = parseHtmlToRaw(html);
});

Given("a raw tree with {int} text nodes", function (n) {
  this.raw = { kind: "root", children: Array.from({ length: n }, () => ({ kind: "text", text: "x" })) };
});

Then("every engine accepts its output unchanged", async function () {
  for (const engine of this.engines) {
    const first = this.results.get(engine.name);
    assert.equal(first.status, "validated", `${engine.name}: first pass rejected`);
    const [second] = await engine.run([first.tree], this.classes);
    assert.equal(second.status, "validated", `${engine.name}: second pass rejected`);
    assert.deepEqual(second.tree, first.tree, `${engine.name}: tree changed`);
    assert.equal(second.changes, 0, `${engine.name}: changes on second pass`);
  }
});

// --- When -------------------------------------------------------------------

When("the policy validates it", async function () {
  await this.validate(["js"]);
});

When("every engine validates it", async function () {
  await this.validate(this.engines.map((e) => e.name));
});

// --- Then: elements ---------------------------------------------------------

Then("no element {string} remains", function (tag) {
  const tree = requireValidated(this);
  const found = elements(tree).filter((e) => e.tag === tag.toLowerCase());
  assert.equal(found.length, 0, `element <${tag}> survived`);
});

Then("the element {string} is unwrapped", function (tag) {
  requireValidated(this);
  const kinds = this.js.kinds.map((k, i) => `${k}:${this.jsChanges[i].tag}`);
  assert.ok(kinds.includes(`unwrapped-element:${tag.toLowerCase()}`), `no unwrapped-element change for <${tag}>; changes: ${kinds.join(", ")}`);
  assert.equal(elements(this.js.tree).filter((e) => e.tag === tag.toLowerCase()).length, 0, `<${tag}> still present`);
});

Then("the elements remaining are {string}", function (list) {
  const tree = requireValidated(this);
  const got = elements(tree).map((e) => `${e.ns}:${e.tag}`).join(" ");
  assert.equal(got, list.trim().replace(/\s+/g, " "));
});

Then("the document is rejected with {string}", function (code) {
  assert.ok(this.js, "no validation result; add a When step");
  assert.equal(this.js.status, "rejected", "document was not rejected");
  assert.ok(this.js.reasons.includes(code), `rejection reasons ${JSON.stringify(this.js.reasons)} do not include ${code}`);
});

// --- Then: attributes -------------------------------------------------------

Then("no attribute matching {string} remains", function (pattern) {
  const tree = requireValidated(this);
  const re = new RegExp(pattern, "i");
  const hits = [];
  for (const e of elements(tree)) for (const [name] of e.attrs) if (re.test(name)) hits.push(`${e.tag}[${name}]`);
  assert.deepEqual(hits, [], `attributes matching ${pattern} survived`);
});

Then("{string} has attribute {string} equal to {string}", function (tag, name, value) {
  const tree = requireValidated(this);
  const el = elements(tree).find((e) => e.tag === tag.toLowerCase());
  assert.ok(el, `no <${tag}> in output`);
  assert.equal(attrsOf(el)[name], value);
});

Then("{string} has no attribute {string}", function (tag, name) {
  const tree = requireValidated(this);
  const el = elements(tree).find((e) => e.tag === tag.toLowerCase());
  assert.ok(el, `no <${tag}> in output`);
  assert.equal(attrsOf(el)[name], undefined, `<${tag}> still has ${name}`);
});

// --- Then: text -------------------------------------------------------------

Then("the text {string} is kept", function (s) {
  assert.ok(textOf(requireValidated(this)).includes(s), `text ${JSON.stringify(s)} not found`);
});

Then("the text does not contain {string}", function (s) {
  assert.ok(!textOf(requireValidated(this)).includes(s), `text ${JSON.stringify(s)} found`);
});

// --- Then: traceability and cross-engine agreement --------------------------

Then("a change cites rule {word}", function (rule) {
  assert.ok(this.js, "no validation result; add a When step");
  assert.ok(this.js.status === "validated", "rules are only recorded for validated documents");
  assert.ok(this.js.rules.includes(rule), `no change cited ${rule}; rules cited: ${[...new Set(this.js.rules)].join(", ") || "none"}`);
  for (const [name, summary] of this.results) {
    if (name === "js") continue;
    assert.ok(summary.rules.includes(rule), `engine ${name} did not cite ${rule}`);
  }
});

Then("all engines agree", function () {
  assert.ok(this.results.size >= 1, "no results");
  const ran = [...this.results.keys()];
  for (const [name, summary] of this.results) {
    if (name === "js") continue;
    const d = firstDiff(this.js, summary);
    assert.equal(d, null, `engine ${name} disagrees with js: ${d}`);
  }
  this.attach(`engines: ${ran.join(", ")}`);
});
