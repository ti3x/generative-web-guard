import { test } from "node:test";
import assert from "node:assert/strict";
import { imageAvailable, runDifferential } from "../scripts/lean-differential.mjs";

// Only the explicitly JS-only command skips this check. Missing Lean fails.
const skip = process.env.GUARD_SKIP_LEAN === "1" && process.env.GUARD_REQUIRE_LEAN !== "1";

test("[R-RCDATA-NO-REPARSE] Lean checker and policy.js agree on corpus and random inputs", { skip: skip && "explicit JS-only development run" }, async () => {
  assert.ok(imageAvailable(), "Lean is required: run npm run setup:verification, or explicitly use npm run test:js");
  const mismatches = await runDifferential({ fuzz: Number(process.env.FUZZ || 200), seed: 1, log: () => {} });
  assert.deepEqual(mismatches.map((m) => m.diff), []);
});
