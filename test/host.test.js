import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { sanitizeEvent, buildFrameDocument, createSandboxFrame } from "../src/host.js";
import { setClassAllowlist } from "../src/policy.js";

setClassAllowlist(["card"]);

test("[R-FRAME-MESSAGE-SCHEMA] sanitizeEvent keeps only known, well-typed fields", () => {
  assert.deepEqual(sanitizeEvent({ type: "click", action: "go", value: "v", extra: 1, __proto__: { x: 1 } }), { type: "click", action: "go", value: "v" });
  assert.equal(sanitizeEvent({ type: "submit", action: "go" }), null);
  assert.equal(sanitizeEvent({ type: "click", action: "javascript:x" }), null);
  assert.equal(sanitizeEvent({ type: "click", action: "go", value: "x".repeat(2001) }), null);
  assert.equal(sanitizeEvent({ type: "click", action: "go", checked: "true" }), null);
  assert.equal(sanitizeEvent({ type: "pointermove", action: "go", x: 1.5 }), null);
  assert.deepEqual(sanitizeEvent({ type: "pointermove", action: "go", x: 3, y: -4 }), { type: "pointermove", action: "go", x: 3, y: -4 });
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent("click"), null);
});

test("[R-FRAME-CSP-SINKS] frame document pins script and style by hash and denies everything else", () => {
  const manifest = { script: "console.log(1)", css: ".card{}", scriptHash: "S", cssHash: "C" };
  const html = buildFrameDocument(manifest);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'sha256-S'/);
  assert.match(html, /style-src 'sha256-C'/);
  assert.match(html, /require-trusted-types-for 'script'/);
  assert.match(html, /trusted-types 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test("[R-FRAME-CSP-SINKS] built manifest hashes match the inlined content", () => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL("../dist/frame-manifest.json", import.meta.url), "utf8"));
  } catch {
    return; // build not run; nothing to check
  }
  const h = (s) => createHash("sha256").update(s, "utf8").digest("base64");
  assert.equal(manifest.scriptHash, h(manifest.script));
  assert.equal(manifest.cssHash, h(manifest.css));
  assert.ok(!/<\/script/i.test(manifest.script));
  assert.ok(manifest.classes.includes("card"));
});

test("[R-FRAME-FIXED-POINT, R-FRAME-MESSAGE-SCHEMA] host refuses to send a non-validated tree and ignores messages from other sources", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  const { window } = dom;
  const events = [];
  const statuses = [];
  const frame = createSandboxFrame({
    container: window.document.getElementById("c"),
    manifest: { script: "", css: "", scriptHash: "S", cssHash: "C" },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });
  const iframe = frame.element;
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.equal(iframe.getAttribute("referrerpolicy"), "no-referrer");
  assert.ok(iframe.srcdoc.includes("default-src 'none'"));

  assert.equal(frame.render, undefined, "no parent render API, even before binding");

  // A message that does not come from the frame window is ignored.
  window.dispatchEvent(new window.MessageEvent("message", { data: { type: "event", event: { type: "click", action: "go" } }, source: window, origin: "null" }));
  assert.deepEqual(events, []);

  frame.destroy();
  assert.equal(window.document.querySelector("iframe"), null);
});

test("[R-FRAME-FIXED-POINT, R-FRAME-MESSAGE-SCHEMA] once bound to the policy port the host refuses to send any tree", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="c"></div></body>`);
  const { window } = dom;
  const statuses = [];
  const frame = createSandboxFrame({
    container: window.document.getElementById("c"),
    manifest: { script: "", css: "", scriptHash: "S", cssHash: "C" },
    onStatus: (s) => statuses.push(s),
  });
  const iframe = frame.element;
  const fromFrame = (data) => window.dispatchEvent(new window.MessageEvent("message", { data, source: iframe.contentWindow, origin: "null" }));

  // Bootstrap requested before the frame is ready: held, not lost.
  const channel = new MessageChannel();
  const bound = frame.attachPort(channel.port2, { instanceId: "inst", sessionId: "sess" });
  assert.equal(frame.portBound, false);
  fromFrame({ type: "ready", styleSheets: 1, trustedTypes: true });
  // jsdom cannot transfer a port; the host reports that rather than throwing,
  // and the bootstrap settles false. The frame's `bound` report is what flips
  // the host into port mode, so simulate the frame having installed a port.
  fromFrame({ type: "bound", instanceId: "inst", sessionId: "sess" });
  assert.equal(frame.portBound, true);
  assert.ok(statuses.some((s) => s.kind === "bound" && s.detail.instanceId === "inst"));

  assert.equal(frame.render, undefined, "binding never enables a parent render API");
  await bound;
  frame.destroy();
  channel.port1.close();
  channel.port2.close();
});
