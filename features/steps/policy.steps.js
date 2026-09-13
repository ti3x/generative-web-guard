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

// --- capability kernel (R-CAP-*) --------------------------------------------
// Profile validation is a build-time check over rules/policy.json against the
// reviewed kernel in rules/capabilities.json. It runs on the profile data
// alone, so these scenarios do not depend on any corpus case, parser output or
// engine being available.
import { readFileSync } from "node:fs";
import { validatePolicy, loadCapabilities } from "../../scripts/gen-policy.mjs";

const shippedProfile = () =>
  JSON.parse(readFileSync(new URL("../../rules/policy.json", import.meta.url), "utf8"));

// Named profile edits. Each is a single realistic authoring mistake.
const PROFILE_CHANGES = {
  "allow the iframe element": (p) => { p.htmlElements.iframe = null; },
  "allow the svg use element": (p) => { p.svgElements.use = null; },
  "give div an href attribute validated as text": (p) => { p.htmlElements.div = { href: ["text"] }; },
  "give svg a src attribute validated as text": (p) => { p.svgGlobal.src = ["text"]; },
  "validate svg fill as plain text": (p) => { p.svgGlobal.fill = ["text"]; },
  "validate svg stroke as plain text": (p) => { p.svgGlobal.stroke = ["text"]; },
  "validate stroke-width as a signed number": (p) => { p.svgGlobal["stroke-width"] = ["num"]; },
  "invent a data-secret attribute": (p) => { p.sharedGlobal["data-secret"] = ["text"]; },
  "widen the dir enum": (p) => { p.htmlGlobal.dir = ["oneOf", ["ltr", "rtl", "auto", "anything"]]; },
  "widen the aria-level range": (p) => { p.sharedGlobal["aria-level"] = ["int", 1, 99]; },
  "widen the stroke-dasharray bound": (p) => { p.svgGlobal["stroke-dasharray"] = ["numList", 4096]; },
  "unwrap script instead of dropping it": (p) => { p.htmlUnwrap.push(["script", "R-EXEC-SCRIPT"]); },
  "raise the node limit": (p) => { p.limits.maxNodes = 500000; },
  "raise the attribute value limit": (p) => { p.limits.maxAttrValueLength = 20000; },
  "raise the traversal ceiling": (p) => { p.limits.maxTraversalDepth = 100000; },
  "drop the forced button type": (p) => { delete p.htmlForced.button; },
  "force button type submit": (p) => { p.htmlForced.button = [["type", "submit"]]; },
  "drop the forced input autocomplete": (p) => { delete p.htmlForced.input; },
  "drop the mandatory input type attribute": (p) => { delete p.htmlElements.input.type; },
  "open the svg title text-only context": (p) => { p.svgTextOnly = p.svgTextOnly.filter((t) => t !== "title"); },
  "narrow the input type enum": (p) => { p.htmlElements.input.type = ["tagged", "R-CTRL-INPUT-TYPE", ["oneOf", ["text", "number"]]]; },
  "narrow the aria-level range": (p) => { p.sharedGlobal["aria-level"] = ["int", 2, 3]; },
  "pin the dir attribute to one value": (p) => { p.htmlGlobal.dir = ["oneOf", ["ltr"]]; },
  "drop the meter element": (p) => { delete p.htmlElements.meter; },
  "drop the select element and its forced attributes": (p) => { delete p.htmlElements.select; delete p.htmlForced.select; },
  "lower the node and depth limits": (p) => { p.limits.maxNodes = 10; p.limits.maxDepth = 4; },
  "shrink the stroke-dasharray bound": (p) => { p.svgGlobal["stroke-dasharray"] = ["numList", 2]; },
  "make svg text a text-only context": (p) => { p.svgTextOnly = [...p.svgTextOnly, "text"]; },
};

Given("the shipped profile", function () {
  this.profile = shippedProfile();
});

Given("the shipped profile with the change {string}", function (name) {
  const mutate = PROFILE_CHANGES[name];
  assert.ok(mutate, `unknown profile change ${JSON.stringify(name)}`);
  this.profile = shippedProfile();
  mutate(this.profile);
});

When("the profile is checked against the capability kernel", function () {
  assert.ok(this.profile, "no profile; add a Given step");
  this.profileError = null;
  try {
    validatePolicy(this.profile, loadCapabilities());
  } catch (error) {
    this.profileError = error;
  }
});

Then("the profile is accepted", function () {
  assert.equal(this.profileError, null, `profile rejected: ${this.profileError?.message}`);
});

Then("the profile is rejected because it {string}", function (fragment) {
  assert.ok(this.profileError, "profile was accepted");
  assert.ok(
    this.profileError.message.includes(fragment),
    `rejection message ${JSON.stringify(this.profileError.message)} does not mention ${JSON.stringify(fragment)}`,
  );
});

Then("the kernel grammar for {string} remains {string}", function (attribute, family) {
  assert.ok(this.profileError, "profile was accepted");
  const message = this.profileError.message;
  assert.ok(message.includes(`attribute ${attribute}`), `rejection does not name ${attribute}: ${message}`);
  assert.ok(
    message.includes(`kernel grammar ["${family}"]`),
    `rejection does not name the kernel grammar ${family}: ${message}`,
  );
});
