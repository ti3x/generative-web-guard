import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseHtmlToRaw } from "../src/adapters/parse5.js";
import { checkTree, setClassAllowlist } from "../src/policy.js";
import { createRenderer } from "../src/render.js";
import { NS } from "../src/tree.js";

setClassAllowlist(["card", "btn"]);

function setup() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  // Any use of an HTML sink during rendering must fail the test.
  const sinkTrap = (name) => () => { throw new Error(`sink used: ${name}`); };
  Object.defineProperty(window.Element.prototype, "innerHTML", { set: sinkTrap("innerHTML"), get: () => "" });
  Object.defineProperty(window.Element.prototype, "outerHTML", { set: sinkTrap("outerHTML"), get: () => "" });
  window.Element.prototype.insertAdjacentHTML = sinkTrap("insertAdjacentHTML");
  doc.write = sinkTrap("document.write");
  window.Range.prototype.createContextualFragment = sinkTrap("createContextualFragment");
  const mount = doc.getElementById("root");
  return { window, doc, mount, renderer: createRenderer(doc, mount) };
}

const treeOf = (html) => {
  const r = checkTree(parseHtmlToRaw(html));
  assert.equal(r.status, "validated");
  return r.tree;
};

test("[R-RENDER-CONSTRUCTORS-ONLY] renders elements in the right namespace without any HTML sink", () => {
  const { mount, renderer } = setup();
  renderer.render(treeOf(`<div class="card"><p>hi &lt;b&gt;</p><svg viewBox="0 0 10 10"><rect width="1" height="1"></rect></svg></div>`));
  const div = mount.firstChild;
  assert.equal(div.namespaceURI, NS.html);
  assert.equal(div.getAttribute("class"), "card");
  assert.equal(div.firstChild.textContent, "hi <b>");
  assert.equal(div.firstChild.childNodes.length, 1); // text node, not an element
  const svg = div.lastChild;
  assert.equal(svg.namespaceURI, NS.svg);
  assert.equal(svg.firstChild.namespaceURI, NS.svg);
  assert.equal(svg.firstChild.localName, "rect");
});

test("[R-RENDER-CONSTRUCTORS-ONLY] renderer refuses forged nodes even if handed to it directly", () => {
  const { renderer } = setup();
  assert.throws(() => renderer.render({ kind: "root", children: [{ kind: "el", ns: "html", tag: "script", attrs: [], children: [] }] }), /refused element/);
  assert.throws(() => renderer.render({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["onclick", "1"]], children: [] }] }), /refused attribute/);
  assert.throws(() => renderer.render({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["style", "x"]], children: [] }] }), /refused attribute/);
  assert.throws(() => renderer.render({ kind: "root", children: [{ kind: "el", ns: "svg", tag: "rect", attrs: [["xlink:href", "x"]], children: [] }] }), /refused attribute/);
});

test("[R-RENDER-CONSTRUCTORS-ONLY] patching updates text and attributes in place and removes stale attributes", () => {
  const { mount, renderer } = setup();
  renderer.render(treeOf(`<p class="card" title="a">one</p>`));
  const p = mount.firstChild;
  renderer.render(treeOf(`<p class="btn">two</p>`));
  assert.equal(mount.firstChild, p); // same node
  assert.equal(p.getAttribute("class"), "btn");
  assert.equal(p.hasAttribute("title"), false);
  assert.equal(p.textContent, "two");
  renderer.render(treeOf(`<div>x</div>`));
  assert.notEqual(mount.firstChild, p); // tag changed: replaced
  assert.equal(mount.firstChild.localName, "div");
});

test("[R-RENDER-CONSTRUCTORS-ONLY] focus and selection survive a re-render; typed value is not clobbered", () => {
  const { doc, mount, renderer } = setup();
  const view = (label) => treeOf(`<div><label for="q">${label}</label><input id="q" data-action="filter" value=""><button data-action="go">go</button></div>`);
  renderer.render(view("Search"));
  const input = mount.querySelector("input");
  input.focus();
  input.value = "hello";
  input.setSelectionRange(2, 4);
  assert.equal(doc.activeElement, input);
  renderer.render(view("Search (updated)"));
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, "hello");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  // A changed validated value attribute does update the control.
  renderer.render(treeOf(`<div><label for="q">S</label><input id="q" data-action="filter" value="reset"><button data-action="go">go</button></div>`));
  assert.equal(input.value, "reset");
});

test("[R-RENDER-CONSTRUCTORS-ONLY] checkbox state follows the validated attribute only when it changes", () => {
  const { mount, renderer } = setup();
  renderer.render(treeOf(`<input type="checkbox" data-action="t">`));
  const box = mount.firstChild;
  box.checked = true; // user toggled
  renderer.render(treeOf(`<input type="checkbox" data-action="t">`)); // unchanged attrs
  assert.equal(box.checked, true);
  renderer.render(treeOf(`<input type="checkbox" data-action="t" checked>`));
  assert.equal(box.checked, true);
  renderer.render(treeOf(`<input type="checkbox" data-action="t">`)); // checked removed
  assert.equal(box.checked, false);
});

test("[R-RENDER-CONSTRUCTORS-ONLY] clear empties the mount", () => {
  const { mount, renderer } = setup();
  renderer.render(treeOf(`<p>a</p><p>b</p>`));
  assert.equal(mount.childNodes.length, 2);
  renderer.clear();
  assert.equal(mount.childNodes.length, 0);
});
