// Policy Worker core: bounded parse5 preprocessing, candidate construction,
// and LEAN/WASM ACCEPTANCE.
//
// This module is environment-neutral so the same code runs in the browser
// Worker (src/policy-worker.js) and in Node tests. It owns the whole of the
// target data flow between a bounded HTML string and an accepted tree:
//
//   bounded HTML string -> parse5 -> bounded raw tree
//     -> JS candidate builder (proposal + diagnostics)
//     -> Lean/Wasm checkTree  (THE AUTHORITY)
//     -> accepted tree + one-time acceptance record
//
// WHO DECIDES
//
// Lean decides. `checker.check` runs the existing whole-checker entry point
// `Guard.checkTree`, which includes its output-policy postcondition and its
// replay (a second normalization that must reproduce the tree with no further
// changes). The tree that leaves this module is the tree that call returned.
// The JavaScript candidate is a proposal and a source of diagnostics; it is
// never what gets rendered, and an unrelated success flag never authorizes it.
//
// THERE IS NO FALLBACK
//
// No checker, a failed startup, a poisoned instance, a rejection, a malformed
// response or a timeout all produce a structured rejection. None of them
// produces an acceptance. If Lean cannot run, this module refuses to render;
// falling back to the JavaScript checker would be a bypass of the authority,
// which is the one thing this phase exists to prevent.
//
// LEGACY CHECKS KEPT ON PURPOSE
//
// The JavaScript checker still runs, and its candidate must equal Lean's
// accepted tree exactly. A disagreement refuses the document
// (`authority-mismatch`). `isValidated` then re-checks Lean's tree with the
// host's own predicate. Both are redundant with Lean deciding; the plan keeps
// them until the end-to-end authority path has integration evidence, and
// Phase 6 -- not this phase -- is where duplication is removed.
//
// GENERATED JAVASCRIPT NEVER RUNS HERE. There is no eval, no Function, no
// QuickJS, no importScripts and no dynamic module load in this module or in
// what it imports. Generated programs run only in the QuickJS Worker.

import { checkTree, isValidated, setClassAllowlist } from "./policy.js";
import { preprocessHtml } from "./adapters/parse5.js";
import { mintAcceptance } from "./acceptance.js";
import {
  POLICY_MESSAGE,
  POLICY_PROTOCOL_VERSION,
  PREPROCESS_LIMITS,
  boundDiagnostics,
  isPolicyEnvelope,
  policyRejection,
  replyEnvelope,
  utf8ByteLength,
} from "./policy-protocol.js";

/** The only authority string an accepted reply may carry. */
export const LEAN_AUTHORITY = "lean-wasm";

/**
 * Structural tree equality, iteratively. Used for the candidate/authority
 * differential gate, so it must not itself be a deep-recursion hazard on a
 * hostile tree -- that is the whole point of the R3 discipline.
 */
export function sameTree(a, b) {
  const stack = [[a, b]];
  let steps = 0;
  while (stack.length > 0) {
    if (++steps > 200_000) return false; // bounded; a tree this size cannot be accepted anyway
    const [x, y] = stack.pop();
    if (x === y) continue;
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return false;
    if (x.kind !== y.kind) return false;
    if (x.kind === "text") {
      if (x.text !== y.text) return false;
      continue;
    }
    if (x.kind === "el") {
      if (x.ns !== y.ns || x.tag !== y.tag) return false;
      const ax = x.attrs, ay = y.attrs;
      if (!Array.isArray(ax) || !Array.isArray(ay) || ax.length !== ay.length) return false;
      for (let i = 0; i < ax.length; i++) {
        if (!Array.isArray(ax[i]) || !Array.isArray(ay[i])) return false;
        if (ax[i][0] !== ay[i][0] || ax[i][1] !== ay[i][1]) return false;
      }
    } else if (x.kind !== "root") {
      return false;
    }
    const cx = x.children, cy = y.children;
    if (!Array.isArray(cx) || !Array.isArray(cy) || cx.length !== cy.length) return false;
    for (let i = 0; i < cx.length; i++) stack.push([cx[i], cy[i]]);
  }
  return true;
}

function countNodes(tree) {
  let count = 0;
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.kind !== "root") count += 1;
    for (const child of node.children ?? []) stack.push(child);
  }
  return count;
}

/**
 * @param {object} [options]
 * @param {object} [options.limits]   overrides merged over PREPROCESS_LIMITS
 * @param {string[]} [options.classes] trusted host class allowlist
 * @param {object} [options.checker]
 *        The Lean/Wasm checker (src/lean-checker.js). REQUIRED for any
 *        acceptance. Constructed in-process at Worker startup only; a message
 *        can never install, replace or disable it, and there is no code path
 *        that accepts a document without it.
 * @param {(raw:object)=>object} [options.candidateBuilder]
 *        TEST-ONLY injection for the JavaScript candidate builder, defaulting
 *        to `checkTree`. It exists so a negative control can force the
 *        candidate builder to emit a forbidden tree and demonstrate that the
 *        document is still refused, rather than asserting that it would be.
 *        Like `checker`, it is an in-process constructor argument: no message
 *        field reads it, the Worker entry never passes it, and it cannot
 *        weaken acceptance -- Lean still decides, and a candidate that differs
 *        from Lean's accepted tree refuses the document.
 */
export function createPolicyCore(options = {}) {
  const limits = options.limits ? { ...PREPROCESS_LIMITS, ...options.limits } : PREPROCESS_LIMITS;
  const checker = options.checker ?? null;
  const buildCandidate = typeof options.candidateBuilder === "function" ? options.candidateBuilder : checkTree;
  // Fixed at construction from the build-time frame manifest. NOT settable by
  // a message: see the class-allowlist check in preprocess().
  const classes = Array.isArray(options.classes) ? [...options.classes] : null;

  function preprocess(request) {
    // ---- the authority must exist, first, before any work --------------
    if (!checker) {
      return policyRejection("checker-unavailable", {
        detail: "no Lean/Wasm checker is installed; this build refuses to render without one",
      });
    }
    if (checker.poisoned) {
      return policyRejection("checker-poisoned", {
        detail: "the checker instance trapped and is not reusable; this session must be replaced",
      });
    }

    // The class allowlist is a property of the INSTANCE, not of a request.
    // Lean's copy was sealed into the module at startup and cannot be changed
    // at all; this list is the same one, and it keeps the JavaScript candidate
    // builder in step with it.
    //
    // A request may still carry `classes` -- the host sends its list once per
    // session -- but it is only ever CHECKED here, never adopted. A
    // disagreement means the host and the built instance were configured from
    // different manifests, which would otherwise show up later as a confusing
    // per-document `authority-mismatch`; say so instead.
    if (Array.isArray(request.classes)) {
      const mine = classes ?? [];
      const theirs = request.classes;
      const differs = theirs.length !== mine.length || theirs.some((c, i) => c !== mine[i]);
      if (differs) {
        return policyRejection("class-allowlist-mismatch", {
          detail: `the session sent ${theirs.length} classes; this instance was built with ${mine.length}`,
        });
      }
    }
    if (classes) setClassAllowlist(classes);

    const pre = preprocessHtml(request.html, { limits });
    if (pre.status === "rejected") return pre;

    // ---- proposal: the JavaScript candidate builder ---------------------
    let candidate;
    try {
      candidate = buildCandidate(pre.raw);
    } catch (error) {
      // A candidate-builder fault is a rejection, never an accepted document.
      const message = error && typeof error.message === "string" ? error.message : String(error);
      return policyRejection("checker-failed", { detail: message });
    }

    // ---- authority: Lean/Wasm checkTree on the same raw tree ------------
    const requestId = `${request.requestId ?? 0}`;
    let verdict;
    try {
      verdict = checker.check(requestId, pre.raw);
    } catch (error) {
      // createLeanChecker converts traps into refusals, so reaching here means
      // the checker object itself is broken. Still a refusal.
      const message = error && typeof error.message === "string" ? error.message : String(error);
      return policyRejection("checker-faulted", { detail: message });
    }
    if (!verdict || typeof verdict !== "object") {
      return policyRejection("authority-malformed", { detail: "the checker returned no verdict" });
    }
    if (verdict.status === "rejected") {
      return policyRejection("lean-rejected", {
        detail: (verdict.reasons ?? []).slice(0, 8).join(","),
      });
    }
    if (verdict.status !== "accepted") {
      return policyRejection("lean-error", { detail: verdict.reason?.code ?? String(verdict.status) });
    }
    const tree = verdict.tree;

    // ---- legacy check 1: the proposal must match the authority ----------
    // Keeping this means a candidate-builder bug cannot silently change what
    // renders, and a divergence is visible instead of resolved in favour of
    // one side. Phase 6 retires it; until then a mismatch refuses.
    if (candidate.status !== "validated") {
      return policyRejection("authority-mismatch", {
        detail: `lean accepted, js candidate ${candidate.status}: ${(candidate.reasons ?? []).map((r) => r.code).join(",")}`.slice(0, 200),
      });
    }
    if (!sameTree(candidate.tree, tree)) {
      return policyRejection("authority-mismatch", { detail: "the js candidate differs from the accepted tree" });
    }

    // ---- legacy check 2: the host's own predicate on Lean's tree --------
    if (!isValidated(tree)) {
      return policyRejection("authority-tree-unvalidated", {
        detail: "the accepted tree is not a fixed point of the host predicate",
      });
    }

    // ---- transport bound on the exact bytes that will be posted ---------
    const serialized = JSON.stringify(tree);
    const bytes = utf8ByteLength(serialized);
    if (bytes > limits.maxCandidateUtf8Bytes) {
      return policyRejection("candidate-bytes-exceeded", {
        limit: "maxCandidateUtf8Bytes",
        limitValue: limits.maxCandidateUtf8Bytes,
        observed: bytes,
      });
    }

    // ---- mint the one-time acceptance next to the verdict ---------------
    let acceptance;
    try {
      acceptance = mintAcceptance({
        authority: LEAN_AUTHORITY,
        checker: checker.identity,
        instanceId: request.instanceId,
        sessionId: request.sessionId,
        generation: request.generation,
        requestId: request.requestId,
        treeNodes: countNodes(tree),
        treeUtf8Bytes: bytes,
      });
    } catch (error) {
      return policyRejection("acceptance-mint-failed", { detail: error && error.message });
    }

    const diagnostics = boundDiagnostics(candidate.changes, limits);
    return {
      status: "accepted",
      authority: LEAN_AUTHORITY,
      acceptance,
      tree,
      diagnostics,
      stats: {
        ...pre.stats,
        candidateTransportUtf8Bytes: bytes,
        leanChanges: verdict.changes,
        checkerVersion: checker.identity.checkerVersion,
      },
    };
  }

  return {
    preprocess,
    get limits() { return limits; },
    get checker() { return checker; },
    /** Bounded identity of the installed authority, or null. */
    get authority() { return checker ? { name: LEAN_AUTHORITY, ...checker.identity } : null; },
  };
}

/**
 * Protocol front door. Validates the envelope, dispatches, and converts any
 * unexpected throw - including a parse5 or checker fault - into a structured
 * reply. Used by the Worker entry and by Node tests.
 */
export function handlePolicyRequest(core, message) {
  if (!isPolicyEnvelope(message)) {
    // No trustworthy identity to echo, so this reply carries none and the
    // client cannot match it to a request. Only the trusted host builds these
    // envelopes; a malformed one is a host bug that its own request budget
    // will surface, not something a guest can send.
    return { protocol: POLICY_PROTOCOL_VERSION, kind: POLICY_MESSAGE.refused, reason: { code: "bad-envelope" } };
  }
  if (message.kind !== POLICY_MESSAGE.preprocess) {
    return replyEnvelope(message, POLICY_MESSAGE.refused, { reason: { code: "unknown-request" } });
  }
  let body;
  try {
    body = core.preprocess(message);
  } catch (error) {
    const text = error && typeof error.message === "string" ? error.message : String(error);
    body = policyRejection("worker-fault", { detail: text });
  }
  return replyEnvelope(message, POLICY_MESSAGE.result, body);
}
