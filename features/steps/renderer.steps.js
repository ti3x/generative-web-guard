// Step definitions for the renderer: DOM from the structured tree with
// constructors only, refusal of forged nodes, in-place patching and focus
// preservation. JavaScript-only rule: R-RENDER-CONSTRUCTORS-ONLY.
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseHtmlToRaw } from "../../src/adapters/parse5.js";
import { checkTree, setClassAllowlist } from "../../src/policy.js";
import { createRenderer } from "../../src/render.js";
import { NS } from "../../src/tree.js";

function setup(world) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  world.sinkUses = [];
  const trap = (name) => () => { world.sinkUses.push(name); throw new Error(`sink used: ${name}`); };
  Object.defineProperty(window.Element.prototype, "innerHTML", { set: trap("innerHTML"), get: () => "" });
  Object.defineProperty(window.Element.prototype, "outerHTML", { set: trap("outerHTML"), get: () => "" });
  window.Element.prototype.insertAdjacentHTML = trap("insertAdjacentHTML");
  doc.write = trap("document.write");
  window.Range.prototype.createContextualFragment = trap("createContextualFragment");
  world.rdoc = doc;
  world.mount = doc.getElementById("root");
  world.renderer = createRenderer(doc, world.mount);
  setClassAllowlist(["card", "btn"]);
}

function treeOf(html) {
  const r = checkTree(parseHtmlToRaw(html));
  assert.equal(r.status, "validated", JSON.stringify(r));
  return r.tree;
}

function render(world, tree) {
  world.renderError = null;
  try { world.renderer.render(tree); } catch (err) { world.renderError = err; }
}

// --- Given / When -----------------------------------------------------------

Given("a rendered tree from HTML:", function (html) {
  setup(this);
  render(this, treeOf(html));
});

When("the tree is re-rendered from HTML:", function (html) {
  render(this, treeOf(html));
});

Given("the renderer is handed a forged {string} element", function (tag) {
  setup(this);
  render(this, { kind: "root", children: [{ kind: "el", ns: "html", tag, attrs: [], children: [] }] });
});

Given("the renderer is handed a div with attribute {string}", function (name) {
  setup(this);
  render(this, { kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [[name, "x"]], children: [] }] });
});

When("the user focuses the input and types {string}", function (value) {
  const input = this.mount.querySelector("input");
  input.focus();
  input.value = value;
  input.setSelectionRange(1, 2);
  this.focused = input;
});

When("the user checks the checkbox", function () {
  this.mount.querySelector("input").checked = true;
});

// --- Then -------------------------------------------------------------------

Then("no HTML sink was used", function () {
  assert.equal(this.renderError, null, `render error: ${this.renderError?.message}`);
  assert.deepEqual(this.sinkUses, []);
});

Then("the renderer refuses with {string}", function (pattern) {
  assert.ok(this.renderError, "renderer did not refuse");
  assert.match(this.renderError.message, new RegExp(pattern));
});

Then("the first element is {string} in the {string} namespace", function (tag, ns) {
  const el = this.mount.firstChild;
  assert.equal(el.localName, tag);
  assert.equal(el.namespaceURI, NS[ns]);
});

Then("the {string} element contains a single text node {string}", function (tag, text) {
  const el = this.mount.querySelector(tag);
  assert.ok(el, `no <${tag}>`);
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.firstChild.nodeType, 3);
  assert.equal(el.textContent, text);
});

Then("the SVG child {string} is in the SVG namespace", function (tag) {
  const el = this.mount.querySelector(tag);
  assert.ok(el, `no <${tag}>`);
  assert.equal(el.namespaceURI, NS.svg);
});

Then("focus stays on the input with value {string} and selection {int} to {int}", function (value, start, end) {
  const input = this.mount.querySelector("input");
  assert.equal(this.rdoc.activeElement, input);
  assert.equal(input, this.focused, "input node was replaced");
  assert.equal(input.value, value);
  assert.equal(input.selectionStart, start);
  assert.equal(input.selectionEnd, end);
});

Then("the input value is {string}", function (value) {
  assert.equal(this.mount.querySelector("input").value, value);
});

Then("the checkbox is {string}", function (state) {
  assert.equal(this.mount.querySelector("input").checked, state === "checked");
});

Then("the mount has {int} child nodes", function (n) {
  assert.equal(this.mount.childNodes.length, n);
});

Then("the {string} element no longer has attribute {string}", function (tag, name) {
  assert.equal(this.mount.querySelector(tag).hasAttribute(name), false);
});

When("the renderer is cleared", function () {
  this.renderer.clear();
});
