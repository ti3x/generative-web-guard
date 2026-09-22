import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { runSessionTrace } from "./session-model-support.js";
import { fuzzSessions } from "../scripts/fuzz-session.mjs";

test("[R-FRAME-MESSAGE-SCHEMA, R-RT-LIMITS] seeded session and guard models obey delivery, acknowledgement and cleanup invariants", { timeout: 30000 }, async () => {
  await fuzzSessions({ seed: 1, iterations: 100, report: "phase7-output/session-smoke.json" });
});
for (const file of readdirSync(new URL("./fixtures/phase7/", import.meta.url)).filter(f => f.startsWith("session-") && f.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/phase7/${file}`, import.meta.url)));
  test(`[R-FRAME-MESSAGE-SCHEMA, R-RT-LIMITS] phase7 ${fixture.name}`, async () => { await runSessionTrace(fixture.input); });
}
