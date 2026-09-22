import { parentPort, workerData } from "node:worker_threads";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { wasmProbe } from "./wasm-probe.mjs";
import { DEFAULT_CLASSES } from "./engines.mjs";
import { createPolicyCore, handlePolicyRequest } from "../../src/policy-core.js";
import { POLICY_MESSAGE, POLICY_PROTOCOL_VERSION, POLICY_TIMEOUTS, PREPROCESS_LIMITS } from "../../src/policy-protocol.js";
import { checkTree, setClassAllowlist } from "../../src/policy.js";
import { isTreeShaped } from "../../src/tree.js";
import { createRenderer } from "../../src/render.js";
import { assertSafeTree } from "../check-policy-properties.mjs";
import { benignTree } from "./policy-fuzz-corpus.mjs";

const classes = workerData.classes ?? DEFAULT_CLASSES;
const probe = await wasmProbe(classes), abi = await wasmProbe(classes);
const initial = probe.measure(), core = createPolicyCore({ checker: probe.checker, classes });
let requestId = 0;
const dom = new JSDOM("<div id='root'></div>"), renderer = createRenderer(dom.window.document, dom.window.document.querySelector("#root"));
function accepted(tree) {
  assert.equal(isTreeShaped(tree), true, "tree shape");
  assertSafeTree(tree, { classes });
  setClassAllowlist(classes);
  const replay = checkTree(tree);
  assert.equal(replay.status, "validated", "JS fixed-point rejection");
  assert.deepEqual(replay.tree, tree, "JS fixed-point changed tree");
  assert.equal(replay.changes.length, 0, "JS fixed-point changes");
  renderer.render(tree); renderer.clear();
}
function textOf(tree) { return tree.kind === "text" ? tree.text : (tree.children ?? []).map(textOf).join(""); }
parentPort.on("message", ({ id, input }) => {
  try {
    if (input.op === "ready") return parentPort.postMessage({ id, value: { identity: probe.checker.identity, initial } });
    const start = performance.now(), before = (input.op === "abi" ? abi : probe).measure();
    let output;
    if (input.op === "pipeline") {
      const result = handlePolicyRequest(core, { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.preprocess,
        instanceId: "fuzz", sessionId: "pipeline", generation: 1, requestId: ++requestId, html: input.html });
      assert.ok(["accepted", "rejected"].includes(result.status), "unstructured outcome");
      assert.equal(probe.checker.poisoned, false, "production input poisoned checker");
      assert.ok(!["worker-fault", "parser-failed", "checker-failed", "checker-faulted", "lean-error"].includes(result.reason?.code), `contained fault: ${JSON.stringify(result.reason)}`);
      if (input.mustAccept) assert.equal(result.status, "accepted", "required benign/corpus content rejected");
      if (result.status === "accepted") {
        accepted(result.tree);
        for (const text of input.mustKeepText ?? []) assert.ok(textOf(result.tree).includes(text), `lost benign text: ${text}`);
        assert.ok(result.diagnostics.records.length <= PREPROCESS_LIMITS.maxDiagnosticRecords);
        assert.ok(result.diagnostics.bytes <= PREPROCESS_LIMITS.maxDiagnosticsUtf8Bytes);
      } else assert.equal("tree" in result, false, "refusal carried tree");
      output = result;
    } else if (input.op === "abi") {
      const bytes = input.bytes ? Uint8Array.from(input.bytes) : new TextEncoder().encode(input.text);
      const raw = abi.raw(bytes, input.length ?? bytes.length);
      if (input.expected.startsWith("shim:")) assert.equal(raw.status, Number(input.expected.slice(5)));
      else {
        assert.equal(raw.status, 0, "unexpected shim refusal");
        if (input.expected === "nonaccepted") assert.notEqual(raw.response.status, "accepted");
        else if (input.expected !== "valid") assert.equal(raw.response.status, input.expected, "wrong decoder outcome");
        if (raw.response.status === "accepted") accepted(raw.response.tree);
        else { assert.ok(["error", "rejected"].includes(raw.response.status)); assert.equal("tree" in raw.response, false); }
      }
      const control = abi.checker.check("after-malformation", benignTree);
      assert.equal(control.status, "accepted", "ABI did not recover from malformed request");
      assert.equal(abi.checker.poisoned, false);
      output = { status: raw.status === 0 ? raw.response.status : `shim:${raw.status}` };
    } else throw new Error(`unknown operation ${input.op}`);
    const elapsedMs = performance.now() - start, after = (input.op === "abi" ? abi : probe).measure();
    assert.ok(elapsedMs <= POLICY_TIMEOUTS.requestMs, `document exceeded ${POLICY_TIMEOUTS.requestMs}ms`);
    assert.equal(after.memoryBytes, before.memoryBytes, "linear memory grew");
    parentPort.postMessage({ id, value: { ...output, elapsedMs, ...after, heapBreakDelta: after.heapBreak - before.heapBreak } });
  } catch (error) { parentPort.postMessage({ id, error: error.stack ?? String(error) }); }
});
