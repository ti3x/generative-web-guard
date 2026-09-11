// Stable browser entry point for the committed CDN bundles. All third-party
// imports are bundled by scripts/build.mjs; consumers only import one module.

import manifest from "../dist/frame-manifest.js";
import { parseHtmlToRaw } from "./adapters/parse5.js";
import { checkTree, isValidated, setClassAllowlist } from "./policy.js";
import { createSandboxFrame } from "./host.js";
import { gateProgram } from "./gate.js";
import { createRuntimeController } from "./runtime/controller.js";

setClassAllowlist(manifest.classes);

/** Parse untrusted HTML with parse5 and apply the tree policy. */
export function guardHtml(html) {
  if (typeof html !== "string") throw new TypeError("guardHtml: expected an HTML string");
  return checkTree(parseHtmlToRaw(html));
}

/** Create the null-origin frame with the build-time policy manifest. */
export function createGuardFrame(options) {
  return createSandboxFrame({ ...options, manifest });
}

export {
  manifest,
  parseHtmlToRaw,
  checkTree,
  isValidated,
  gateProgram,
  createRuntimeController,
};
