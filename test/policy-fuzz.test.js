import { test } from "node:test";
import { leanSkip } from "./lean-support.js";
import { fuzzPolicy } from "../scripts/fuzz-policy.mjs";

test("[R-CHECK-ACCEPTANCE, R-LIMIT-TREE] seeded input and raw ABI fuzzing preserves fixed points, benign content and checker availability", { skip: leanSkip(), timeout: 120000 }, async () => {
  await fuzzPolicy({ seed: 7, iterations: 250, native: process.env.GUARD_REQUIRE_LEAN === "1", report: "phase7-output/policy-smoke.json" });
});
