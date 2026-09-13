// Test support for the Lean/Wasm authority.
//
// Deliberately NOT named `*.test.js`, so `node --test test/*.test.js` does not
// treat it as a test file.
//
// Two kinds of checker live here:
//
//   realChecker()  the shipped artifact, instantiated from lean/wasm/dist.
//                  Requires `npm run wasm:build`. Under `npm test`
//                  (GUARD_REQUIRE_LEAN=1) a missing build must FAIL, not skip.
//
//   stubChecker()  in-process injections for the negative controls: a checker
//                  that rejects a benign candidate, one that is missing, one
//                  that is poisoned, one that returns corrupt output. These
//                  exist so "Lean prevents rendering" is demonstrated rather
//                  than asserted.
//
// Every stub is a constructor argument to `createPolicyCore`, exactly like the
// real checker. None of them is reachable from a message: `handlePolicyRequest`
// reads only `kind`, `html`, `classes` and the identity fields, and there is no
// message that installs, replaces or disables a checker.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLeanChecker } from "../src/lean-checker.js";
import { LEAN_ABI_VERSION, LEAN_CHECKER_VERSION, LEAN_PROFILE } from "../src/lean-abi.js";
import { CAPABILITY_VERSION } from "../src/capabilities-data.js";

const WASM_MJS = new URL("../lean/wasm/dist/guard.mjs", import.meta.url);
const WASM_BIN = new URL("../lean/wasm/dist/guard.wasm", import.meta.url);

export const CLASSES = ["card", "muted"];

export function wasmBuilt() {
  return existsSync(WASM_MJS) && existsSync(WASM_BIN);
}

/**
 * A skip reason, or `false` when the test must run.
 *
 * `false` and not `null`: node:test skips on any value other than `false` or
 * `undefined`, so returning `null` here would silently skip everything.
 *
 * `npm test` sets GUARD_REQUIRE_LEAN=1 and then a missing build is a failure,
 * which is what keeps the full verification path honest. Only the explicitly
 * JS-only development command skips.
 */
export function leanSkip() {
  if (wasmBuilt()) return false;
  if (process.env.GUARD_REQUIRE_LEAN === "1") return false; // must fail loudly
  return "lean/wasm/dist is not built; run npm run wasm:build, or npm test";
}

export function requireWasm() {
  assert.ok(
    wasmBuilt(),
    "the Lean/Wasm checker is required: run npm run wasm:build (Docker), or use npm run test:js for the explicitly JS-only checks",
  );
}

let shared = null;

/** The shipped checker. Cached per process; one instance is enough. */
export async function realChecker({ classes = CLASSES, stylesheetHash = "test-stylesheet", fresh = false } = {}) {
  requireWasm();
  const key = `${JSON.stringify(classes)}|${stylesheetHash}`;
  if (!fresh && shared && shared.key === key) return shared.checker;
  const createModule = (await import(pathToFileURL(WASM_MJS.pathname).href)).default;
  const checker = await createLeanChecker({
    createModule,
    wasmBinary: new Uint8Array(readFileSync(WASM_BIN.pathname)),
    classes,
    stylesheetHash,
  });
  if (!fresh) shared = { key, checker };
  return checker;
}

export function rawWasmBinary() {
  requireWasm();
  return new Uint8Array(readFileSync(WASM_BIN.pathname));
}

export async function rawCreateModule() {
  requireWasm();
  return (await import(pathToFileURL(WASM_MJS.pathname).href)).default;
}

/** The identity a real checker must report. */
export const EXPECTED_IDENTITY = Object.freeze({
  abi: LEAN_ABI_VERSION,
  checkerVersion: LEAN_CHECKER_VERSION,
  capabilityVersion: CAPABILITY_VERSION,
  profile: LEAN_PROFILE,
});

/**
 * An injectable checker with the same surface as the real one.
 *
 * @param {(requestId:string, document:object)=>object} check
 * @param {object} [extra] `{ poisoned }`
 */
export function stubChecker(check, extra = {}) {
  return {
    identity: { ...EXPECTED_IDENTITY, inputCapacity: 2_200_000, wasmBytes: 1, classes: CLASSES.length, stylesheetHash: "stub" },
    get poisoned() { return extra.poisoned === true; },
    calls: 0,
    check,
    dispose() {},
  };
}

/** Rejects everything, including a benign document. */
export const rejectingChecker = () => stubChecker(() => ({ status: "rejected", reasons: ["injected-negative-control"] }));

/** Trapped and unusable. */
export const poisonedChecker = () => stubChecker(() => ({ status: "error", reason: { code: "lean-checker-poisoned" } }), { poisoned: true });

/** Claims acceptance but returns nothing usable. */
export const corruptChecker = (tree) => stubChecker(() => ({ status: "accepted", tree, changes: 0, changeKinds: [], changeRules: [] }));
