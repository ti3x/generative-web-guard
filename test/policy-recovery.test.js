import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicySession } from "../src/policy-client.js";
import { createPolicyDispatcher } from "../src/policy-dispatcher.js";
import { stubChecker, CLASSES } from "./lean-support.js";

test("[R-RT-LIMITS] phase7 manual-poison-recovery: fatal checker refusal replaces the Worker on the next request", async () => {
  const workers = [];
  const session = createPolicySession({ classes: CLASSES, createWorker() {
    const bad = workers.length === 0, listeners = new Set();
    let poisoned = false;
    const checker = stubChecker((_id, tree) => {
      if (bad) { poisoned = true; return { status: "error", reason: { code: "lean-checker-poisoned" } }; }
      return { status: "accepted", tree };
    });
    Object.defineProperty(checker, "poisoned", { get: () => poisoned });
    const dispatcher = createPolicyDispatcher({ classes: CLASSES, post: data => queueMicrotask(() => {
      if (!worker.terminated) for (const fn of [...listeners]) fn({ data });
    }) });
    const worker = {
      terminated: false,
      addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
      removeEventListener(_type, fn) { listeners.delete(fn); },
      postMessage(message, ports) { queueMicrotask(() => { if (!worker.terminated) dispatcher.receive(message, ports); }); },
      terminate() { worker.terminated = true; dispatcher.dispose(); },
    };
    workers.push(worker);
    queueMicrotask(() => { dispatcher.start(); dispatcher.ready(checker); });
    return worker;
  } });
  try {
    const first = await session.preprocess("<p>benign-control</p>");
    assert.equal(first.reason.code, "checker-poisoned");
    assert.equal(workers[0].terminated, true);
    const second = await session.preprocess("<p>recovered</p>");
    assert.equal(second.status, "accepted");
    assert.equal(workers.length, 2);
    assert.equal(session.pendingCount, 0);
  } finally { session.dispose(); }
});
