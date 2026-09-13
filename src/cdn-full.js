// Single-file CDN entry point.
//
// The QuickJS Worker and the policy Worker are embedded here AS SOURCE, with
// no runtime import of anything, so a page can create them from blob: URLs
// even when this module itself was loaded from a different CDN origin. That is
// not a convenience:
//
//   * `new Worker("https://cdn/worker.js")` fails on Chromium, Firefox and
//     WebKit under every CSP including no CSP at all. The Worker constructor
//     fetches a dedicated worker's script same-origin; no directive changes
//     that. So the payload has to travel inside this module.
//   * A blob: Worker inherits this document's CSP. A same-origin network
//     Worker does not -- it would run with eval, new Function and unrestricted
//     fetch available unless the host serves a CSP header on the worker script
//     itself. See docs/csp.md (Profile A vs Profile B).
//   * The payloads are fully self-contained IIFE bundles, so there is no
//     import inside a Worker at all. If a payload ever needed one it would
//     have to be `await import()` (checked against script-src) and never a
//     static top-level import (checked against worker-src, and it fails with
//     no violation report). scripts/build.mjs asserts this.

import workerSource from "guard:worker-source";
import policyWorkerSource from "guard:policy-worker-source";
import { createRuntimeController } from "./runtime/controller.js";
import { createPolicySession } from "./policy-client.js";
import { createBlobWorker } from "./startup.js";
import manifest from "../dist/frame-manifest.js";
import { createSandboxFrame } from "./host.js";
import { createGuardWith } from "./guard.js";

export * from "./cdn.js";

/**
 * The integrated API (src/guard.js). Owns the sandboxed frame, the policy
 * Worker with its embedded Lean authority, the private port between them,
 * and -- when a program is supplied -- the QuickJS Worker. Every view goes
 * through Lean before the frame sees it, and the host never holds a tree.
 *
 *   const guard = await createGuard({ container, onStatus });
 *   await guard.render({ html });                    // static document
 *   await guard.render({ program, data });           // interactive program
 *   await guard.clear();
 *   guard.dispose();
 */
export const createGuard = createGuardWith({
  manifest,
  createFrame: (options) => createSandboxFrame(options),
  createPolicySession: (options) => createPolicySession({ ...options, createWorker: () => createBlobWorker(policyWorkerSource) }),
  createRuntime: (options) => createRuntimeController({ ...options, createWorker: () => createBlobWorker(workerSource) }),
});

/**
 * Create a Worker from a self-contained source string via a blob: URL. Raises
 * a StartupError with a code such as `csp-worker-blob` rather than an opaque
 * DOMException. Exported so a host can reuse the same diagnostics.
 */
export function createGuardBlobWorker(source, options = {}) {
  return createBlobWorker(source, options);
}

export function createGuardWorker(options = {}) {
  return createBlobWorker(workerSource, options);
}

export function createGuardRuntime(options = {}) {
  const { worker: workerOptions, ...controllerOptions } = options;
  return createRuntimeController({
    ...controllerOptions,
    createWorker: () => createGuardWorker(workerOptions),
  });
}

/** The policy Worker: bounded parse5 preprocessing and candidate construction. */
export function createGuardPolicyWorker(options = {}) {
  return createBlobWorker(policyWorkerSource, options);
}

/**
 * Host-side policy session backed by that Worker. Preprocessing, candidate
 * construction and LEAN/WASM ACCEPTANCE run off the host event loop, and a
 * request that exceeds its budget terminates the Worker.
 *
 * The Worker instantiates the embedded Lean checker at startup and seals this
 * build's class allowlist and stylesheet identity into it. `whenReady()`
 * resolves when the channel works; `whenCheckerReady()` resolves when the
 * authority exists. Until the second one resolves nothing can be accepted, and
 * if it rejects nothing ever will be: there is no fallback to the JavaScript
 * checker.
 */
export function createGuardPolicySession(options = {}) {
  const { worker: workerOptions, ...sessionOptions } = options;
  return createPolicySession({
    classes: manifest.classes,
    ...sessionOptions,
    createWorker: () => createGuardPolicyWorker(workerOptions),
  });
}

/**
 * The embedded Worker payload sizes. Exported for diagnostics and for the CDN
 * check; the sources themselves are not exported, because handing a page an
 * arbitrary Worker payload string is not a capability this entry point should
 * offer beyond the two factories above.
 */
export const embeddedWorkerBytes = Object.freeze({
  quickjs: workerSource.length,
  policy: policyWorkerSource.length,
});
