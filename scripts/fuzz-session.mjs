import { pathToFileURL } from "node:url";
import { runSessionTrace, sessionActions } from "../test/session-model-support.js";
import { options, provenance, report, failure, readReplay, reduceSequence } from "./lib/fuzz-support.mjs";

export async function fuzzSessions({ seed = 1, iterations = 100, minutes = 0, replay, report: reportPath = "phase7-output/session.json" } = {}) {
  const metadata = { ...provenance("session"), seed }, counts = { traces: 0, operations: 0 };
  const started = performance.now();
  for (let i = 0; i < iterations && (!minutes || performance.now() - started < minutes * 60000); i++) {
    const input = replay ? (readReplay(replay).input ?? readReplay(replay))
      : { seed: (seed + i) >>> 0, mode: i % 2 ? "guard" : "session", actions: sessionActions((seed + i) >>> 0) };
    try {
      const row = await runSessionTrace(input);
      counts.traces++; counts.operations += row.operations;
    } catch (error) {
      const original = failure(reportPath, metadata, input, error);
      const signature = error.message;
      const reduced = await reduceSequence(input.actions, async actions => {
        try { await runSessionTrace({ ...input, actions }); return false; } catch (e) { return e.message === signature; }
      });
      report(reportPath, { ...original, minimized: { ...input, actions: reduced.sequence }, reductionAttempts: reduced.attempts });
      throw error;
    }
    if (replay) break;
  }
  const result = { ...metadata, status: "passed", ...counts, elapsedMs: performance.now() - started };
  report(reportPath, result); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options();
  console.log(JSON.stringify(await fuzzSessions(o)));
}
