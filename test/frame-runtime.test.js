import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { startFrame } from "../src/frame.js";
import { FRAME_PROTOCOL_VERSION, FRAME_MESSAGE } from "../src/frame-protocol.js";

test("[R-FRAME-MESSAGE-SCHEMA, R-FRAME-FIXED-POINT] actual frame refuses parent trees before binding, renders only the port, drops replay", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const win = dom.window;
  const reports = [];
  const parent = { postMessage: msg => reports.push(msg) };
  Object.defineProperty(win, "parent", { value: parent });
  startFrame(win);
  const tree = { kind: "root", children: [{ kind: "text", text: "accepted" }] };
  const parentMessage = (data, ports = []) => win.dispatchEvent(new win.MessageEvent("message", { data, source: parent, ports }));
  parentMessage({ type: "render", seq: 1, tree });
  assert.equal(reports.at(-1).type, "refused");
  assert.equal(win.document.getElementById("root").textContent, "");
  const channel = new MessageChannel();
  const ids = { instanceId: "actual-frame", sessionId: "one" };
  parentMessage({ type: "bootstrap", protocol: FRAME_PROTOCOL_VERSION, ...ids }, [channel.port2]);
  const messages = [];
  let resolveNext = null;
  channel.port1.onmessage = event => {
    messages.push(event.data);
    if (resolveNext) resolveNext(event.data);
  };
  const nextAck = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolveNext = null; reject(new Error("frame acknowledgement timed out")); }, 2000);
    resolveNext = message => { clearTimeout(timer); resolveNext = null; resolve(message); };
  });
  const command = { protocol: FRAME_PROTOCOL_VERSION, kind: FRAME_MESSAGE.render, ...ids, seq: 1, generation: 0, requestId: 1, tree };
  try {
    const firstAck = nextAck();
    channel.port1.postMessage(command);
    await firstAck;
    assert.equal(messages[0]?.kind, FRAME_MESSAGE.rendered);
    assert.equal(win.document.getElementById("root").textContent, "accepted");
    channel.port1.postMessage({ ...command, tree: { kind: "root", children: [{ kind: "text", text: "replay" }] } });
    parentMessage({ type: "render", seq: 2, tree });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(messages.length, 1, "replay is not acknowledged or rendered");
    assert.equal(reports.at(-1).type, "refused");
    assert.equal(win.document.getElementById("root").textContent, "accepted");
    const refusedAck = nextAck();
    channel.port1.postMessage({ ...command, seq: 2, requestId: 2, tree: { kind: "root", children: [{ kind: "el", ns: "html", tag: "script", attrs: [], children: [] }] } });
    await refusedAck;
    assert.equal(messages.at(-1)?.kind, FRAME_MESSAGE.refused, "renderer construction assertions remain");
    assert.equal(messages.length, 2, "the intervening replay never produced an acknowledgement");
  } finally {
    channel.port1.close(); channel.port2.close(); win.document.body.remove(); dom.window.close();
  }
});
