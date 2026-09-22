import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { policyCases, abiCases } from "./lib/policy-fuzz-corpus.mjs";
import { options, provenance, report, failure, readReplay, supervised, reduceSequence } from "./lib/fuzz-support.mjs";
import { leanDockerEngine, DEFAULT_CLASSES } from "./lib/engines.mjs";
import { POLICY_TIMEOUTS } from "../src/policy-protocol.js";

const WORKER = new URL("./lib/policy-fuzz-worker.mjs", import.meta.url);
export async function fuzzPolicy({ seed = 1, iterations = 250, minutes = 0, replay,
  native = false, mode = "both", report: reportPath = "phase7-output/policy.json", reduce = true } = {}) {
  assert.ok(["both", "pipeline", "abi"].includes(mode), "unknown fuzz mode");
  const metadata = { ...provenance("policy"), seed, native, timeoutMs: POLICY_TIMEOUTS.requestMs },
    counts = {}, rows = [], nativeBatch = [];
  const engine = native ? leanDockerEngine() : null;
  if (engine) assert.ok(engine.available(), "requested native Lean engine is unavailable");
  const worker = await supervised(WORKER), started = performance.now();
  const pipeline = policyCases(seed), abi = abiCases(seed, worker.info.identity.limits);
  const acceptedPath = reportPath.replace(/\.json$/, "") + "-accepted.jsonl";
  mkdirSync(dirname(acceptedPath), { recursive: true }); writeFileSync(acceptedPath, "");
  let current, cases = 0, exported = 0, peakHeapBreak = 0, maxDelta = 0;
  async function flushNative() {
    if (!engine || !nativeBatch.length) return;
    const outputs = await engine.run(nativeBatch.map(c => c.tree), DEFAULT_CLASSES);
    assert.equal(outputs.length, nativeBatch.length);
    for (let i = 0; i < outputs.length; i++) {
      current = nativeBatch[i].input;
      assert.equal(outputs[i].status, "validated", "native fixed-point rejection");
      assert.deepEqual(outputs[i].tree, nativeBatch[i].tree, "native fixed-point changed tree");
      assert.equal(outputs[i].changes, 0, "native fixed-point changes");
    }
    nativeBatch.length = 0;
  }
  try {
    for (let i = 0; i < iterations && (!minutes || performance.now() - started < minutes * 60000); i++) {
      const replayInput = replay && readReplay(replay);
      const inputs = replay ? [replayInput.input ?? replayInput]
        : mode === "both" ? [pipeline(i), abi(i)] : [mode === "abi" ? abi(i) : pipeline(i)];
      for (const input of inputs) {
        current = { ...input, seed, index: i };
        const result = await worker.run(input, POLICY_TIMEOUTS.requestMs + 1000);
        cases++;
        const key = `${input.op}:${result.status}:${result.reason?.code ?? ""}`;
        counts[key] = (counts[key] ?? 0) + 1;
        peakHeapBreak = Math.max(peakHeapBreak, result.heapBreak); maxDelta = Math.max(maxDelta, result.heapBreakDelta);
        if (rows.length < 2000) rows.push({ index: i, label: input.label, status: result.status, reason: result.reason, elapsedMs: result.elapsedMs, heapBreak: result.heapBreak, heapBreakDelta: result.heapBreakDelta });
        if (result.status === "accepted" && result.tree) {
          if (engine) nativeBatch.push({ input: current, tree: result.tree });
          if (exported < 256) {
            appendFileSync(acceptedPath, JSON.stringify({ input: current, tree: result.tree, classes: DEFAULT_CLASSES, checkerSha256: metadata.checkerSha256 }) + "\n"); exported++;
          }
          if (nativeBatch.length >= 25) await flushNative();
        }
      }
      if (replay) break;
    }
    await flushNative();
    const result = { ...metadata, status: "passed", cases, counts, exported, acceptedPath,
      peakHeapBreak, maxHeapBreakDelta: maxDelta, elapsedMs: performance.now() - started, measurements: rows };
    report(reportPath, result); return result;
  } catch (error) {
    const original = failure(reportPath, metadata, current, error);
    if (reduce && current?.op === "pipeline" && !native && typeof current.html === "string") {
      const signature = error.message.split("\n")[0];
      const reduced = await reduceSequence([...current.html], async chars => {
        const w = await supervised(WORKER);
        try { await w.run({ ...current, html: chars.join("") }, POLICY_TIMEOUTS.requestMs + 1000); return false; }
        catch (e) { return e.message.split("\n")[0] === signature; }
        finally { await w.close(); }
      }, 20);
      report(reportPath, { ...original, minimized: { ...current, html: reduced.sequence.join("") }, reductionAttempts: reduced.attempts });
    }
    throw error;
  } finally { await worker.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options({}, { native: { type: "boolean", default: false }, mode: { type: "string", default: "both" } });
  const { measurements, ...summary } = await fuzzPolicy(o);
  console.log(JSON.stringify(summary));
}
