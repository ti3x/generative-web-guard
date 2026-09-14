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
import { createSandboxFrame } from "./host.js";
import { createRuntimeController } from "./runtime/controller.js";
import { createPolicySession } from "./policy-client.js";
import { PREPROCESS_LIMITS, POLICY_PROTOCOL_VERSION, POLICY_TIMEOUTS } from "./policy-protocol.js";
import { LEAN_ABI_VERSION, LEAN_AUTHORITY, LEAN_CHECKER_VERSION, LEAN_PROFILE } from "./lean-abi.js";
import {
  STARTUP_ERRORS,
  STARTUP_STAGES,
  STARTUP_TIMEOUTS,
  STARTUP_WARNINGS,
  StartupError,
  createBlobWorker,
} from "./startup.js";

/** Create an inert frame, then bind it with createGuardPolicySession({ frame }).
 * There is no render(tree) or acceptance-token commit API. */
export function createGuardFrame(options = {}) {
  return createSandboxFrame({ ...options, manifest });
}

export {
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
  createRuntimeController,
};
