// Worker-only pipeline: bounded HTML -> parse5 -> JS proposal -> Lean candidate
// acceptance -> exact authority tree. JS diagnostics cannot authorize a commit.
// Missing, trapped, malformed or rejecting Lean always refuses; no fallback.
import { buildCandidate as proposeTree, setClassAllowlist } from "./policy.js";
import { isTreeShaped } from "./tree.js";
import { previewTree } from "./preview.js";
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

// Unwrapping can turn a shallow raw tree into a wide candidate. Reapply the
// measured engine-work bound to the ACTUAL Wasm input, without deciding policy.
function candidatePathNodes(tree, limits) {
  if (!isTreeShaped(tree)) return Infinity;
  const stack = [{ children: tree.children, path: 0 }];
  let nodes = 0, peak = 0;
  while (stack.length) {
    const { children, path } = stack.pop();
    for (let i = 0; i < children.length; i++) {
      if (++nodes > limits.maxRawNodes) return Infinity;
      const next = path + i + 1;
      peak = Math.max(peak, next);
      if (peak > limits.maxRawPathNodes) return peak;
      if (children[i].kind === "el") stack.push({ children: children[i].children, path: next });
    }
  }
  return peak;
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
 *        to `buildCandidate`. It exists so a negative control can force the
 *        candidate builder to emit a forbidden tree and demonstrate that the
 *        document is still refused, rather than asserting that it would be.
 *        Like `checker`, it is an in-process constructor argument: no message
 *        field reads it, the Worker entry never passes it, and it cannot
 *        weaken acceptance -- Lean still decides whether the proposed tree is acceptable.
 */
export function createPolicyCore(options = {}) {
  const limits = options.limits ? { ...PREPROCESS_LIMITS, ...options.limits } : PREPROCESS_LIMITS;
  const checker = options.checker ?? null;
  const buildCandidate = typeof options.candidateBuilder === "function" ? options.candidateBuilder : proposeTree;
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
    // different manifests. Refuse it explicitly before building a candidate.
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

    if (!candidate || candidate.status !== "proposed") {
      return policyRejection("candidate-rejected", { detail: (candidate?.reasons ?? []).map(r => r.code).join(",") });
    }
    const pathNodes = candidatePathNodes(candidate.tree, limits);
    if (pathNodes > limits.maxRawPathNodes) {
      return policyRejection("candidate-path-nodes-exceeded", {
        limit: "maxRawPathNodes", limitValue: limits.maxRawPathNodes,
        observed: Number.isFinite(pathNodes) ? pathNodes : limits.maxRawNodes + 1,
      });
    }
    const bytes = utf8ByteLength(JSON.stringify(candidate.tree));
    if (bytes > limits.maxCandidateUtf8Bytes) {
      return policyRejection("candidate-bytes-exceeded", {
        limit: "maxCandidateUtf8Bytes", limitValue: limits.maxCandidateUtf8Bytes, observed: bytes,
      });
    }

    // Only Lean can accept this proposal. Bound serialization BEFORE Wasm.
    const requestId = `${request.requestId ?? 0}`;
    let verdict;
    try {
      verdict = checker.check(requestId, candidate.tree);
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
    if (!isTreeShaped(tree)) return policyRejection("authority-tree-malformed");

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
      ...(request.preview === true ? { preview: previewTree(tree) } : {}),
      stats: {
        ...pre.stats,
        candidateTransportUtf8Bytes: bytes,
        candidatePathNodes: pathNodes,
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
