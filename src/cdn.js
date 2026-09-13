// Stable browser entry point for the committed CDN bundles. All third-party
// imports are bundled by scripts/build.mjs; consumers only import one module.
//
// The optional development linter (gateProgram) is NOT part of this entry
// point any more: it is not a security boundary, and keeping it here kept
// Acorn in the default dependency path. Import it from
// cdn/generative-web-guard.lint.js (src/cdn-lint.js) when a generator needs
// diagnostics. See README and src/gate.js.

import manifest from "../dist/frame-manifest.js";
import { parseHtmlToRaw, preprocessHtml, PreprocessLimitError } from "./adapters/parse5.js";
import { checkTree, isValidated, setClassAllowlist } from "./policy.js";
import { createSandboxFrame } from "./host.js";
import { createRuntimeController } from "./runtime/controller.js";
import { createPolicySession } from "./policy-client.js";
import { PREPROCESS_LIMITS, POLICY_PROTOCOL_VERSION, POLICY_TIMEOUTS } from "./policy-protocol.js";
import {
  ACCEPTANCE_NONCE_BYTES,
  ACCEPTANCE_REGISTRY_MAX,
  createAcceptanceRegistry,
  isAcceptanceToken,
} from "./acceptance.js";
import { LEAN_ABI_VERSION, LEAN_CHECKER_VERSION, LEAN_PROFILE } from "./lean-abi.js";
import { LEAN_AUTHORITY } from "./policy-core.js";
import {
  STARTUP_ERRORS,
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  STARTUP_WARNINGS,
  StartupError,
  createBlobWorker,
} from "./startup.js";

setClassAllowlist(manifest.classes);

/**
 * Parse untrusted HTML with parse5 under the preprocessing limits and apply
 * the tree policy. Synchronous, as before: preprocessing limit violations are
 * returned as an ordinary rejection ({ status, reasons }) rather than thrown,
 * so existing callers keep the same control flow.
 *
 * This runs the parser and the checker on the caller's thread. For untrusted
 * input in a UI, prefer createPolicySession(): it moves both into a Worker
 * that can be terminated, which is the only way to bound parser time.
 *
 * WHAT THIS IS NOT. `guardHtml` is the JavaScript checker only. It is a
 * proposal and a diagnostic, NOT an acceptance: the Lean/Wasm authority does
 * not run here, and the tree it returns carries no acceptance record, so it
 * cannot be committed to a frame created by `createGuardFrame`. Treat its
 * `status: "validated"` as "the JavaScript checker had no objection", not as
 * "this document may be rendered". The rendering path is
 * `createGuardPolicySession().preprocess()` followed by
 * `frame.render(result.acceptance)`.
 */
export function guardHtml(html) {
  if (typeof html !== "string") throw new TypeError("guardHtml: expected an HTML string");
  const pre = preprocessHtml(html);
  if (pre.status === "rejected") return { status: "rejected", reasons: [pre.reason] };
  return checkTree(pre.raw);
}

/**
 * Create the null-origin frame with the build-time policy manifest.
 *
 * BREAKING CHANGE in this phase: the frame returned by this entry point
 * commits only ACCEPTANCE RECORDS issued by a policy session, never a tree.
 * Pass the session as `policy` (or its `claimAcceptance` directly) and call
 * `frame.render(result.acceptance)`:
 *
 *   const policy = createGuardPolicySession({ ... });
 *   const frame = createGuardFrame({ container, policy });
 *   const result = await policy.preprocess(html);
 *   if (result.status === "accepted") await frame.render(result.acceptance);
 *
 * This is the point of the phase: every commit through the shipped entry point
 * depends on a matching Lean/Wasm acceptance, and there is no code path that
 * renders a tree the JavaScript checker alone approved. Creating the frame
 * without that binding is refused here rather than silently producing a frame
 * that would accept a bare tree.
 *
 * `createSandboxFrame` still offers the low-level tree path for renderer-level
 * tests and the documented legacy export. Phase 5 moves the remaining callers
 * onto `createGuard`.
 */
export function createGuardFrame(options = {}) {
  const { policy = null, claimAcceptance = null, ...rest } = options;
  const claim = claimAcceptance
    ?? (policy && typeof policy.claimAcceptance === "function" ? (token) => policy.claimAcceptance(token) : null);
  if (typeof claim !== "function") {
    throw new TypeError(
      "createGuardFrame: pass `policy` (a createPolicySession/createGuardPolicySession session) or `claimAcceptance`. "
      + "This entry point renders only acceptance records issued by the Lean/Wasm authority; it does not accept a tree.",
    );
  }
  return createSandboxFrame({ ...rest, manifest, claimAcceptance: claim });
}

export {
  // Acceptance records: the binding between a Lean verdict and a frame commit.
  ACCEPTANCE_NONCE_BYTES,
  ACCEPTANCE_REGISTRY_MAX,
  createAcceptanceRegistry,
  isAcceptanceToken,
  // The Lean/Wasm ABI contract and the authority name, so a consumer can
  // assert what accepted its document rather than trusting a status string.
  LEAN_ABI_VERSION,
  LEAN_CHECKER_VERSION,
  LEAN_PROFILE,
  LEAN_AUTHORITY,
  // Startup diagnostics. The small bundle does not embed the Worker payloads,
  // so a consumer of this entry point supplies its own createWorker; these are
  // exported so that consumer can create it as a blob: Worker with the same
  // per-stage codes the full bundle uses. A cross-origin Worker URL cannot be
  // made to work by any policy -- see docs/csp.md.
  STARTUP_ERRORS,
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  STARTUP_WARNINGS,
  StartupError,
  createBlobWorker,
  manifest,
  parseHtmlToRaw,
  preprocessHtml,
  PreprocessLimitError,
  PREPROCESS_LIMITS,
  POLICY_PROTOCOL_VERSION,
  POLICY_TIMEOUTS,
  createPolicySession,
  checkTree,
  isValidated,
  createRuntimeController,
};
