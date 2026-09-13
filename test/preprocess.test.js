// R3 regressions: bounded preprocessing at the public entry points.
//
// The recursive parse5 adapter overflowed the JS stack on 5,000 nested
// elements (55,001 characters) before any policy limit could reject them, and
// it did so for allowed, unwrapped and dropped elements alike. Every case here
// must produce a structured rejection instead - and the benign controls must
// still be preserved exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { preprocessHtml, parseHtmlToRaw, PreprocessLimitError } from "../src/adapters/parse5.js";
import { preprocessHtmlWithDom } from "../src/adapters/dom.js";
import { PREPROCESS_LIMITS, utf8ByteLength } from "../src/policy-protocol.js";
import { checkTree, setClassAllowlist } from "../src/policy.js";
import { guardHtml } from "../src/cdn.js";

setClassAllowlist(["card", "muted"]);

const L = PREPROCESS_LIMITS;
const nest = (tag, depth, inner = "deep") =>
  `<${tag}>`.repeat(depth) + inner + `</${tag}>`.repeat(depth);

function rejection(html, options) {
  const result = preprocessHtml(html, options);
  assert.equal(result.status, "rejected", `expected a rejection, got ${result.status}`);
  // A defined structured value, not a thrown string and not an exception.
  assert.equal(typeof result.reason, "object");
  assert.equal(typeof result.reason.code, "string");
  return result.reason;
}

// --- deep nesting: allowed, unwrapped and dropped elements ------------------

test("[R-LIMIT-TREE] 5,000 nested allowed elements are rejected, not a stack overflow", () => {
  const reason = rejection(nest("div", 5000));
  assert.equal(reason.code, "raw-depth-exceeded");
  assert.equal(reason.limit, "maxRawDepth");
  assert.equal(reason.limitValue, L.maxRawDepth);
  assert.equal(reason.observed, L.maxRawDepth + 1);
  assert.equal(reason.tag, "div");
});

test("[R-LIMIT-TREE] nesting in UNWRAPPED elements is bounded: the policy's depth counter does not advance for them", () => {
  // <q> is unwrapped, so the checker recurses without incrementing its own
  // depth. Preprocessing is what bounds this shape.
  const reason = rejection(nest("q", 5000));
  assert.equal(reason.code, "raw-depth-exceeded");
  const guarded = guardHtml(nest("q", 5000));
  assert.equal(guarded.status, "rejected");
  assert.equal(guarded.reasons[0].code, "raw-depth-exceeded");
});

test("[R-LIMIT-TREE] nesting in DROPPED elements is bounded too", () => {
  // Unknown elements are dropped with their subtree; the input work was still
  // done, so it is still counted.
  const reason = rejection(nest("x-drop", 5000));
  assert.equal(reason.code, "raw-depth-exceeded");
});

test("[R-LIMIT-TREE] nesting within the raw limit is preprocessed and left to the policy", () => {
  const result = preprocessHtml(nest("div", 40));
  assert.equal(result.status, "ok");
  assert.equal(result.stats.rawDepth, 40);
  // 40 levels exceed the policy's output depth of 32: preprocessing accepts
  // the input, the policy rejects the output. The two limits are independent.
  assert.equal(checkTree(result.raw).status, "rejected");
  const shallow = preprocessHtml(nest("div", 10));
  assert.equal(shallow.status, "ok");
  assert.equal(checkTree(shallow.raw).status, "validated");
});

// --- width, attributes, names, comments, text -------------------------------

// A flat run of siblings is what the Lean checker's per-sibling recursion has
// open all at once, so it is bounded by maxRawPathNodes before the node count
// can matter. The count bound is reached by a wide, SHALLOW tree instead.
test("[R-LIMIT-TREE] a flat run of siblings is bounded by the open-node path", () => {
  const reason = rejection("<p></p>".repeat(L.maxRawPathNodes + 1));
  assert.equal(reason.code, "raw-path-nodes-exceeded");
  assert.equal(reason.limit, "maxRawPathNodes");
  assert.equal(reason.observed, L.maxRawPathNodes + 1);
  const atLimit = preprocessHtml("<p></p>".repeat(L.maxRawPathNodes));
  assert.equal(atLimit.status, "ok");
  assert.equal(atLimit.stats.rawPathNodes, L.maxRawPathNodes);
});

test("[R-LIMIT-TREE] a wide, shallow tree is rejected by the raw node count", () => {
  // 40 paragraphs per group: at most 81 nodes are ever open, so the node total
  // is the bound that trips.
  const group = `<div>${"<p>x</p>".repeat(40)}</div>`;
  const reason = rejection(group.repeat(200));
  assert.equal(reason.code, "raw-nodes-exceeded");
  assert.equal(reason.limit, "maxRawNodes");
  assert.equal(reason.observed, L.maxRawNodes + 1);
});

test("[R-LIMIT-TREE] the open-node path bounds shape, not size: same nodes, different descent", () => {
  // 30 levels with 40 paragraphs beside the descent at every level: 1,231 raw
  // nodes either way. Descending through the LAST child keeps every earlier
  // sibling open (41 per level); through the FIRST child at most 30 + 41 are
  // open, and the document is accepted although it has more nodes than the
  // path bound.
  const last = `<div>${"<p></p>".repeat(40)}`.repeat(30) + "x" + "</div>".repeat(30);
  const first = "<div>".repeat(30) + "x" + `</div>${"<p></p>".repeat(40)}`.repeat(30);
  const reason = rejection(last);
  assert.equal(reason.code, "raw-path-nodes-exceeded");
  assert.ok(reason.observed > L.maxRawPathNodes);
  const ok = preprocessHtml(first);
  assert.equal(ok.status, "ok", JSON.stringify(ok.reason));
  assert.equal(ok.stats.rawNodes, 30 * 41 + 1);
  assert.ok(ok.stats.rawNodes > L.maxRawPathNodes, "more nodes than the path bound, and still accepted");
  assert.ok(ok.stats.rawPathNodes <= 30 + 41, `${ok.stats.rawPathNodes} open at most`);
});

test("[R-LIMIT-TREE] ordinary wide documents are not refused for their node count", () => {
  // Regression: under a 1,000-node cap a 50-row table was refused. These are
  // the shapes generated documents actually take; each exceeds 1,000 raw nodes
  // and none has more than a few hundred open at once.
  const cell = (r, c) => `<td>${r}-${c}</td>`;
  const table = (rows, cols) => `<table><tbody>${Array.from({ length: rows }, (_, r) => `<tr>\n${Array.from({ length: cols }, (_, c) => cell(r, c)).join("\n")}\n</tr>`).join("\n")}</tbody></table>`;
  const list = (n) => `<ul>\n${Array.from({ length: n }, (_, i) => `  <li><strong>Item ${i}</strong> <span class="muted">detail ${i}</span></li>`).join("\n")}\n</ul>`;
  for (const html of [table(100, 8), list(300)]) {
    const result = preprocessHtml(html);
    assert.equal(result.status, "ok", JSON.stringify(result.reason));
    assert.ok(result.stats.rawNodes > 1000, `${result.stats.rawNodes} raw nodes`);
    assert.ok(result.stats.rawPathNodes < 700, `${result.stats.rawPathNodes} open at most`);
  }
});

test("[R-LIMIT-ATTRS] an excessive attribute count is rejected before the policy trims it", () => {
  const many = (n) => `<p ${Array.from({ length: n }, (_, i) => `a${i}="1"`).join(" ")}>t</p>`;
  const reason = rejection(many(L.maxRawAttrsPerElement + 1));
  assert.equal(reason.code, "raw-attrs-exceeded");
  assert.equal(reason.limit, "maxRawAttrsPerElement");
  // Below the raw limit the policy still applies its own, smaller limit.
  const result = preprocessHtml(many(30));
  assert.equal(result.status, "ok");
  const checked = checkTree(result.raw);
  assert.equal(checked.status, "validated");
  assert.ok(checked.changes.some((c) => c.why === "too-many"));
});

test("[R-LIMIT-ATTRS] attribute bytes are bounded per element, in UTF-8 bytes", () => {
  const reason = rejection(`<p title="${"x".repeat(L.maxRawAttrBytesUtf8PerElement + 1)}">t</p>`);
  assert.equal(reason.code, "raw-attr-bytes-exceeded");
  assert.equal(reason.limit, "maxRawAttrBytesUtf8PerElement");
  // Multi-byte characters count as their encoded length, not their code-unit
  // length: 12,000 emoji are 24,000 UTF-16 code units but 48,000 UTF-8 bytes.
  const emoji = "\u{1F600}".repeat(12000);
  assert.equal(emoji.length, 24000);
  assert.equal(utf8ByteLength(emoji), 48000);
  assert.equal(preprocessHtml(`<p title="${emoji}">t</p>`).status, "ok");
  assert.equal(rejection(`<p title="${"\u{1F600}".repeat(17000)}">t</p>`).code, "raw-attr-bytes-exceeded");
});

test("[R-LIMIT-TREE] long element and attribute names are rejected", () => {
  const longTag = rejection(`<${"a".repeat(L.maxRawNameCodeUnits + 1)}>t</a>`);
  assert.equal(longTag.code, "raw-name-too-long");
  assert.equal(longTag.limit, "maxRawNameCodeUnits");
  const longAttr = rejection(`<p ${"b".repeat(L.maxRawNameCodeUnits + 1)}="1">t</p>`);
  assert.equal(longAttr.code, "raw-name-too-long");
  assert.equal(longAttr.attr.length, 64); // bounded diagnostic, not the whole name
});

test("[R-STRUCT-NON-ELEMENT] a comment flood is counted even though every comment is discarded", () => {
  const reason = rejection("<!--c-->".repeat(L.maxRawCommentNodes + 1));
  assert.equal(reason.code, "raw-comment-nodes-exceeded");
  assert.equal(reason.limit, "maxRawCommentNodes");
  // Comments below the limit are still reported as removals by the policy.
  const ok = preprocessHtml("<p>t<!--c--></p>");
  assert.equal(ok.status, "ok");
  assert.equal(ok.stats.commentNodes, 1);
  assert.ok(checkTree(ok.raw).changes.some((c) => c.kind === "removed-node" && c.what === "comment"));
});

test("[R-LIMIT-TREE] a huge text node and a total-text flood are both rejected", () => {
  const single = rejection(`<p>${"x".repeat(L.maxRawTextCodeUnits + 1)}</p>`);
  assert.equal(single.code, "raw-text-too-long");
  assert.equal(single.limit, "maxRawTextCodeUnits");

  // Six text nodes of 190,000 characters: each is under the per-node limit,
  // the sum is over the document limit. Text is measured in UTF-16 code units.
  const chunk = "x".repeat(190000);
  // The source limit would fire first, so it is raised for this case: the
  // point is that the text limits compose, not that the source is short.
  const total = rejection(`<p>${chunk}</p>`.repeat(6), { limits: { maxSourceCodeUnits: 4_000_000 } });
  assert.equal(total.code, "raw-total-text-too-long");
  assert.equal(total.limit, "maxRawTotalTextCodeUnits");
});

test("[R-LIMIT-TREE] total candidate bytes are bounded in UTF-8 bytes", () => {
  // Emoji text: 1,000,000 code units is within the text limits, while its
  // UTF-8 encoding is 2,000,000+ bytes and exceeds the candidate bound.
  const reason = rejection(`<p>${"\u{1F600}".repeat(260000)}</p>`.repeat(3), {
    limits: {
      maxSourceCodeUnits: 4_000_000,
      maxRawTotalTextCodeUnits: 4_000_000,
      maxRawTextCodeUnits: 4_000_000,
    },
  });
  assert.equal(reason.code, "candidate-bytes-exceeded");
  assert.equal(reason.limit, "maxCandidateUtf8Bytes");
});

// --- source length, checked before the parser runs --------------------------

test("[R-LIMIT-TREE] the source limit is enforced before parse5 is invoked", () => {
  const huge = nest("div", 1_000_000, "x"); // ~11 MB, 1,000,000 levels
  const started = Date.now();
  const reason = rejection(huge);
  const elapsed = Date.now() - started;
  assert.equal(reason.code, "source-too-long");
  assert.equal(reason.limit, "maxSourceCodeUnits");
  assert.equal(reason.limitValue, L.maxSourceCodeUnits);
  assert.equal(reason.observed, huge.length);
  // No parse happened: rejecting 11 MB of hostile markup is a length compare.
  assert.ok(elapsed < 250, `source rejection took ${elapsed} ms; the parser must not have run`);
});

test("[R-LIMIT-TREE] the source limit is never smaller than the largest view the runtime can forward", async () => {
  const { DEFAULT_LIMITS } = await import("../src/runtime/protocol.js");
  assert.ok(L.maxSourceCodeUnits >= DEFAULT_LIMITS.maxViewChars);
});

test("[R-LIMIT-TREE] a non-string source is a structured rejection, not a throw", () => {
  for (const value of [null, undefined, 7, {}, ["<p>x</p>"]]) {
    assert.equal(rejection(value).code, "source-not-a-string");
  }
});

test("[R-LIMIT-TREE] the walk's own time budget rejects rather than running unbounded", () => {
  // A clock that jumps past the budget immediately after the first check.
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 10_000);
  // The node and open-node bounds are raised for this case only: the
  // assertion is about the TIME budget, and with the shipped limits a flat run
  // this long would be refused by maxRawPathNodes first and hide it. The
  // budget is sampled every 1,024 ticks, so the input has to be large enough
  // to reach a sample.
  const reason = rejection("<p>x</p>".repeat(2000), { now, limits: { ...L, maxRawNodes: 100_000, maxRawPathNodes: 100_000 } });
  assert.equal(reason.code, "preprocess-budget-exceeded");
  assert.equal(reason.limit, "maxPreprocessMs");
});

// --- the compatibility wrapper ---------------------------------------------

test("[R-LIMIT-TREE] parseHtmlToRaw throws a typed error carrying the structured reason", () => {
  assert.throws(
    () => parseHtmlToRaw(nest("div", 5000)),
    (error) => {
      assert.ok(error instanceof PreprocessLimitError);
      assert.equal(error.reason.code, "raw-depth-exceeded");
      assert.equal(error.reason.limit, "maxRawDepth");
      return true;
    },
  );
  assert.equal(parseHtmlToRaw("<p>ok</p>").children[0].tag, "p");
});

test("[R-LIMIT-TREE] guardHtml returns a rejection in the usual shape instead of throwing", () => {
  const result = guardHtml(nest("div", 5000));
  assert.equal(result.status, "rejected");
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].code, "raw-depth-exceeded");
  assert.throws(() => guardHtml(42), /expected an HTML string/);
});

// --- benign preservation ----------------------------------------------------

test("[R-CHECK-ACCEPTANCE] bounded preprocessing produces the same raw tree as before for benign markup", () => {
  const result = preprocessHtml(
    `<div class="card"><p>A &amp; B</p><svg viewBox="0 0 10 10"><rect xlink:href="#a" width="1"/></svg><template><b>t</b></template><!--c--></div>`,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.raw, {
    kind: "root",
    children: [{
      kind: "el", ns: "html", tag: "div", attrs: [["class", "card"]],
      children: [
        { kind: "el", ns: "html", tag: "p", attrs: [], children: [{ kind: "text", text: "A & B" }] },
        {
          kind: "el", ns: "svg", tag: "svg", attrs: [["viewBox", "0 0 10 10"]],
          children: [{ kind: "el", ns: "svg", tag: "rect", attrs: [["xlink:href", "#a"], ["width", "1"]], children: [] }],
        },
        // <template> content is surfaced so the policy can see and drop it.
        {
          kind: "el", ns: "html", tag: "template", attrs: [],
          children: [{ kind: "el", ns: "html", tag: "b", attrs: [], children: [{ kind: "text", text: "t" }] }],
        },
        { kind: "comment" },
      ],
    }],
  });
  // rawPathNodes: the text inside <b> has the div, the <template> (the div's
  // third child), the <b> and itself open at once.
  assert.deepEqual(result.stats, {
    rawNodes: 9, rawDepth: 3, rawPathNodes: 6, commentNodes: 1, attrs: 4, textCodeUnits: 6, candidateUtf8Bytes: 69,
  });
});

test("[R-CHECK-ACCEPTANCE] iterative conversion preserves document order at depth", () => {
  const result = preprocessHtml("<div><p>1</p><section><p>2</p><p>3</p></section><p>4</p></div>");
  assert.equal(result.status, "ok");
  const text = [];
  (function walk(node) {
    if (node.kind === "text") text.push(node.text);
    for (const child of node.children ?? []) walk(child);
  })(result.raw);
  assert.deepEqual(text, ["1", "2", "3", "4"]);
});

// --- the DOMParser adapter, kept only for parser-differential compatibility -

test("[R-LIMIT-TREE] the compatibility DOMParser adapter is bounded by the same limits", () => {
  const { DOMParser } = new JSDOM("").window;
  const result = preprocessHtmlWithDom(nest("div", 5000), DOMParser);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason.code, "raw-depth-exceeded");
  assert.equal(result.reason.limit, "maxRawDepth");
});

test("[R-RCDATA-NO-REPARSE] the two frontends agree on foster parenting and rawtext for the same input", () => {
  const { DOMParser } = new JSDOM("").window;
  const html = `<div class="card"><table><div onclick="alert(1)">foster</div><tr><td>cell</table><style>@import url(x)</style><textarea><b>raw</b></textarea></div>`;
  const viaParse5 = preprocessHtml(html);
  const viaDom = preprocessHtmlWithDom(html, DOMParser);
  assert.equal(viaParse5.status, "ok");
  assert.equal(viaDom.status, "ok");
  assert.deepEqual(viaDom.raw, viaParse5.raw);
  // And the policy result is identical whichever frontend produced the tree.
  assert.deepEqual(checkTree(viaDom.raw), checkTree(viaParse5.raw));
});
