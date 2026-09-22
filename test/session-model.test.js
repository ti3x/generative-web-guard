import { test } from "node:test";
import { fuzzSessions } from "../scripts/fuzz-session.mjs";

test("[R-FRAME-MESSAGE-SCHEMA, R-RT-LIMITS] seeded session and guard models obey delivery, acknowledgement and cleanup invariants", { timeout: 30000 }, async () => {
  await fuzzSessions({ seed: 1, iterations: 100, report: "phase7-output/session-smoke.json" });
});
