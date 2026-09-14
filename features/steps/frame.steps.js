// Step definitions for the frame protocol: fixed-point re-validation, message
// source and schema checks, and the frame document's sandbox and CSP.
// JavaScript-only rules: R-FRAME-FIXED-POINT, R-FRAME-MESSAGE-SCHEMA, R-FRAME-CSP-SINKS.
import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createSandboxFrame, sanitizeEvent, buildFrameDocument } from "../../src/host.js";
import { checkTree, isValidated, setClassAllowlist } from "../../src/policy.js";
import { parseHtmlToRaw } from "../../src/adapters/parse5.js";
import { startFrame } from "../../src/frame.js";
import { createFrameSender } from "../../src/frame-channel.js";
import { FRAME_PROTOCOL_VERSION } from "../../src/frame-protocol.js";

const MANIFEST = { script: "", css: "", scriptHash: "S", cssHash: "C" };

function newHost(world) {
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  world.hostWindow = dom.window;
  world.hostEvents = [];
  world.hostStatuses = [];
  world.frame = createSandboxFrame({
    container: dom.window.document.getElementById("c"),
    manifest: MANIFEST,
    onEvent: (e) => world.hostEvents.push(e),
    onStatus: (s) => world.hostStatuses.push(s),
  });
  world.sandboxWindow = new JSDOM('<div id="root"></div>').window;
  world.frameReports = [];
  world.testParent = { postMessage: msg => world.frameReports.push(msg) };
  Object.defineProperty(world.sandboxWindow, "parent", { value: world.testParent });
  startFrame(world.sandboxWindow);
}

After(function () {
  this.frame?.destroy();
  this.sender?.dispose();
  this.framePort?.close();
  if (this.sandboxWindow) { this.sandboxWindow.document.body.remove(); this.sandboxWindow.close(); }
  this.hostWindow?.close();
});

// --- Given ------------------------------------------------------------------

Given("a frame host", function () {
  newHost(this);
});

Given("a forged tree containing a {string} element", function (tag) {
  this.tree = { kind: "root", children: [{ kind: "el", ns: "html", tag, attrs: [], children: [] }] };
});

Given("a forged tree with attribute {string} on a div", function (name) {
  this.tree = { kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [[name, "x"]], children: [] }] };
});

Given("a tree with unsorted attributes", function () {
  this.tree = { kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["title", "a"], ["class", "card"]], children: [] }] };
});

Given("a validated tree from the HTML {string}", function (html) {
  setClassAllowlist(["card"]);
  const r = checkTree(parseHtmlToRaw(html));
  assert.equal(r.status, "validated");
  this.tree = r.tree;
});

Given("a frame event:", function (json) {
  this.frameEvent = JSON.parse(json);
});

Given("a frame event with an inherited field", function () {
  this.frameEvent = Object.assign(Object.create({ x: 1 }), { type: "click", action: "go" });
});

// --- When -------------------------------------------------------------------

When("the host is asked to render it", async function () {
  assert.equal(this.frame.render, undefined);
  const win = this.sandboxWindow;
  win.dispatchEvent(new win.MessageEvent("message", { source: this.testParent, data: { type: "render", seq: 1, tree: this.tree } }));
  this.renderResult = this.frameReports.at(-1).type === "rendered";
});

When("the private policy port delivers it", async function () {
  const wasm = this.engines.find(engine => engine.name === "wasm");
  if (wasm) assert.equal((await wasm.checkCandidates([this.tree]))[0].status, "accepted");
  const channel = new MessageChannel();
  const ids = { instanceId: "bdd-frame", sessionId: "bdd-session" };
  this.framePort = channel.port2;
  const win = this.sandboxWindow;
  win.dispatchEvent(new win.MessageEvent("message", { source: this.testParent,
    data: { type: "bootstrap", protocol: FRAME_PROTOCOL_VERSION, ...ids }, ports: [channel.port2] }));
  this.sender = createFrameSender(channel.port1, { ...ids, timeoutMs: 1000 });
  this.renderResult = (await this.sender.render(this.tree, { generation: 0, requestId: 1 })).ok;
});

When("the host receives that event from an unrelated window", function () {
  const win = this.hostWindow;
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "event", event: this.frameEvent }, source: win, origin: "null" }));
});

When("the event is schema-checked", function () {
  this.checked = sanitizeEvent(this.frameEvent);
});

When("the frame document is built", function () {
  this.frameDoc = buildFrameDocument(MANIFEST);
});

// --- Then -------------------------------------------------------------------

Then("the tree is not a policy fixed point", function () {
  assert.equal(isValidated(this.tree), false);
});

Then("the tree is a policy fixed point", function () {
  assert.equal(isValidated(this.tree), true);
});

Then("the host refuses to render it", function () {
  assert.equal(this.renderResult, false);
  assert.equal(this.frameReports.at(-1)?.type, "refused");
  assert.equal(this.sandboxWindow.document.getElementById("root").textContent, "");
});

Then("the private port acknowledges rendering", function () {
  assert.equal(this.renderResult, true);
  assert.equal(this.sandboxWindow.document.getElementById("root").textContent, "accepted content");
});

Then("the host ignores it", function () {
  assert.deepEqual(this.hostEvents, []);
});

Then("the event is accepted as:", function (json) {
  assert.deepEqual(this.checked, JSON.parse(json));
});

Then("the event is rejected", function () {
  assert.equal(this.checked, null);
});

Then("the frame is sandboxed with {string} only", function (flags) {
  assert.equal(this.frame.element.getAttribute("sandbox"), flags);
  assert.equal(this.frame.element.getAttribute("referrerpolicy"), "no-referrer");
});

Then("the frame policy contains {string}", function (directive) {
  assert.ok(this.frameDoc.includes(directive), `missing ${directive}`);
});
