import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidate, checkTree, setClassAllowlist } from "../src/policy.js";
import { parseHtmlToRaw } from "../src/adapters/parse5.js";
import { createPolicyCore } from "../src/policy-core.js";
import { previewTree } from "../src/preview.js";

test("[R-CHECK-ACCEPTANCE] the JS builder proposes once; the full reference checker remains independent", () => {
  setClassAllowlist(["card"]);
  const raw = parseHtmlToRaw('<DIV class="card evil"><script>x</script>hello</DIV>');
  const proposal = buildCandidate(raw);
  const reference = checkTree(raw);
  assert.equal(proposal.status, "proposed");
  assert.equal(reference.status, "validated");
  assert.deepEqual(proposal.tree, reference.tree);
  assert.deepEqual(proposal.changes, reference.changes);
  assert.equal(proposal.acceptance, undefined);
});

test("[R-LIMIT-TREE] unwrapping is bounded on the actual candidate BEFORE calling Wasm", () => {
  let called = 0;
  let accepting = false;
  const checker = {
    identity: { abi: 2, checkerVersion: "test-checker/2.0", capabilityVersion: 0, profile: "default" },
    check(_id, tree) {
      called++;
      return accepting ? { status: "accepted", tree } : { status: "rejected", reasons: ["test authority"] };
    },
  };
  const core = createPolicyCore({ checker });
  const group = n => "<q>" + "<span></span>".repeat(n) + "</q>";
  const at = core.preprocess({ html: group(100).repeat(10) });
  assert.equal(at.reason.code, "lean-rejected");
  assert.equal(called, 1);
  const past = core.preprocess({ html: group(100).repeat(10) + group(1) });
  assert.equal(past.reason.code, "candidate-path-nodes-exceeded");
  assert.equal(called, 1, "over-bound candidate never enters Wasm");
  // The bound is a per-document refusal, not a poisoned instance: the next
  // in-bound document reaches the authority and is accepted.
  accepting = true;
  const after = core.preprocess({ html: group(100).repeat(10), instanceId: "i", sessionId: "s", generation: 0, requestId: 3 });
  assert.equal(after.status, "accepted");
  assert.equal(after.stats.candidatePathNodes, 1000);
  assert.equal(called, 2, "recovery after the refusal invokes the authority once");
});

test("[R-LIMIT-TREE] diagnostic previews are bounded text, never a commit capability", () => {
  const tree = { kind: "root", children: [{ kind: "text", text: '<script>"&' }] };
  assert.equal(previewTree(tree), "&lt;script&gt;&quot;&amp;");
  assert.ok(previewTree(tree, 8).length <= 8);
  assert.match(previewTree(tree, 8), /…$/);
});
