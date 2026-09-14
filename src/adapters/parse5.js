// Parser adapter: parse5 (pinned, non-executing HTML5 parser) to the raw tree
// consumed by checkTree(). This is the single production HTML frontend: it
// needs no browser DOM, so it runs in the terminable policy Worker
// (src/policy-worker.js) as well as in Node for tests and the Lean path.
//
// Output is UNTRUSTED input to the policy. The adapter does no filtering; it
// records namespace, tag, attributes and children faithfully so the policy
// sees what the parser saw.
//
// R3. Both the traversal and the input are bounded here, BEFORE the output
// policy runs:
//   * the source length is checked before parse5 is invoked;
//   * conversion is iterative with an explicit stack, so nesting depth costs
//     heap, not JS stack frames, and 5,000 nested <div>s are rejected by a
//     limit instead of overflowing;
//   * every limit counts input work even when the policy would discard the
//     node (dropped, unwrapped and allowed elements cost the same to parse);
//   * the raw nodes OPEN at once in a depth-first walk are bounded too
//     (maxRawPathNodes): that, not the node count, is what the Lean checker's
//     per-sibling recursion can overflow on. See src/policy-protocol.js;
//   * a limit violation returns the structured rejection defined in
//     src/policy-protocol.js. Nothing here throws a string.
//
// The adapter cannot interrupt parse5 once parseFragment() has started. A
// parser-time limit therefore requires terminating the Worker from outside;
// src/policy-client.js owns that. maxPreprocessMs only bounds this walk.

import { parseFragment } from "parse5";
import { NS } from "../tree.js";
import { PREPROCESS_LIMITS, policyRejection, utf8ByteLength } from "../policy-protocol.js";

export class PreprocessLimitError extends Error {
  constructor(reason) {
    super(`preprocessing rejected: ${reason.code}`);
    this.name = "PreprocessLimitError";
    this.reason = reason;
  }
}

/**
 * Bounded preprocessing: HTML string -> raw tree.
 *
 * @returns {{status:"ok", raw: object, stats: object}
 *          |{status:"rejected", reason: object}}
 */
export function preprocessHtml(html, options = {}) {
  const limits = options.limits ? { ...PREPROCESS_LIMITS, ...options.limits } : PREPROCESS_LIMITS;
  const now = options.now ?? Date.now;

  if (typeof html !== "string") return policyRejection("source-not-a-string");
  // Checked before parse5 runs: the parser's own cost is bounded by input size.
  if (html.length > limits.maxSourceCodeUnits) {
    return policyRejection("source-too-long", {
      limit: "maxSourceCodeUnits",
      limitValue: limits.maxSourceCodeUnits,
      observed: html.length,
    });
  }

  let fragment;
  try {
    fragment = parseFragment(html);
  } catch (error) {
    // parse5 failures are contained here and at the Worker boundary; a parser
    // crash must not look like an accepted document.
    return policyRejection("parser-failed", { detail: errorText(error) });
  }
  return convert(fragment, limits, now);
}

/**
 * Synchronous parsing helper for tests, the Lean differential, and callers
 * that need raw syntax rather than acceptance. Success returns a raw tree; a bounded
 * rejection throws a PreprocessLimitError carrying the structured reason.
 */
export function parseHtmlToRaw(html, options) {
  const result = preprocessHtml(html, options);
  if (result.status === "rejected") throw new PreprocessLimitError(result.reason);
  return result.raw;
}

function errorText(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  return message.slice(0, 200);
}

function childNodesOf(node) {
  const children = node.childNodes ?? [];
  // <template> content lives in a separate fragment; surface it so the policy
  // can see and drop it rather than silently keeping an empty shell.
  if (node.content && node.content.childNodes && node.content.childNodes.length) {
    return children.concat(node.content.childNodes);
  }
  return children;
}

// Iterative depth-first conversion. Each stack entry is one level of the raw
// tree; `out` is the array the level's converted children are appended to.
function convert(fragment, limits, now) {
  const deadline = now() + limits.maxPreprocessMs;
  const stats = {
    rawNodes: 0,
    rawDepth: 0,
    rawPathNodes: 0,
    commentNodes: 0,
    attrs: 0,
    textCodeUnits: 0,
    candidateUtf8Bytes: 0,
  };
  const rootChildren = [];
  const stack = [{ nodes: childNodesOf(fragment), index: 0, out: rootChildren, depth: 0, pathNodes: 0 }];
  let ticks = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
    const position = ++frame.index; // 1-based, among this node's siblings
    const node = frame.nodes[position - 1];

    // The walk's own budget. Checked every 1024 nodes so the clock read is
    // not the dominant cost.
    if ((++ticks & 0x3ff) === 0 && now() > deadline) {
      return policyRejection("preprocess-budget-exceeded", {
        limit: "maxPreprocessMs",
        limitValue: limits.maxPreprocessMs,
        observed: stats.rawNodes,
      });
    }

    if (++stats.rawNodes > limits.maxRawNodes) {
      return policyRejection("raw-nodes-exceeded", {
        limit: "maxRawNodes",
        limitValue: limits.maxRawNodes,
        observed: stats.rawNodes,
        depth: frame.depth,
      });
    }

    // R3, checker side. The Lean checker recurses once per sibling on the
    // engine's call stack, so what it can overflow on is not the node count
    // but how many raw nodes are still OPEN when it reaches this one: its
    // ancestors, itself, and every earlier sibling of each. Measured per
    // engine; see the maxRawPathNodes note in src/policy-protocol.js.
    const pathNodes = frame.pathNodes + position;
    if (pathNodes > limits.maxRawPathNodes) {
      return policyRejection("raw-path-nodes-exceeded", {
        limit: "maxRawPathNodes",
        limitValue: limits.maxRawPathNodes,
        observed: pathNodes,
        depth: frame.depth,
      });
    }
    if (pathNodes > stats.rawPathNodes) stats.rawPathNodes = pathNodes;

    const name = node.nodeName;

    if (name === "#text") {
      const value = typeof node.value === "string" ? node.value : "";
      if (value.length > limits.maxRawTextCodeUnits) {
        return policyRejection("raw-text-too-long", {
          limit: "maxRawTextCodeUnits",
          limitValue: limits.maxRawTextCodeUnits,
          observed: value.length,
          depth: frame.depth,
        });
      }
      stats.textCodeUnits += value.length;
      if (stats.textCodeUnits > limits.maxRawTotalTextCodeUnits) {
        return policyRejection("raw-total-text-too-long", {
          limit: "maxRawTotalTextCodeUnits",
          limitValue: limits.maxRawTotalTextCodeUnits,
          observed: stats.textCodeUnits,
        });
      }
      const overBytes = addCandidateBytes(stats, limits, utf8ByteLength(value));
      if (overBytes) return overBytes;
      frame.out.push({ kind: "text", text: value });
      continue;
    }

    if (name === "#comment" || name === "#documentType" || !node.tagName) {
      // Comments, doctypes and anything else without a tag are discarded by
      // the policy, but they are still parsed and walked, so they are counted.
      if (++stats.commentNodes > limits.maxRawCommentNodes) {
        return policyRejection("raw-comment-nodes-exceeded", {
          limit: "maxRawCommentNodes",
          limitValue: limits.maxRawCommentNodes,
          observed: stats.commentNodes,
        });
      }
      frame.out.push({
        kind: name === "#comment" ? "comment" : name === "#documentType" ? "doctype" : "unknown",
      });
      continue;
    }

    const depth = frame.depth + 1;
    if (depth > limits.maxRawDepth) {
      return policyRejection("raw-depth-exceeded", {
        limit: "maxRawDepth",
        limitValue: limits.maxRawDepth,
        observed: depth,
        tag: node.tagName.slice(0, 64),
      });
    }
    if (depth > stats.rawDepth) stats.rawDepth = depth;

    if (node.tagName.length > limits.maxRawNameCodeUnits) {
      return policyRejection("raw-name-too-long", {
        limit: "maxRawNameCodeUnits",
        limitValue: limits.maxRawNameCodeUnits,
        observed: node.tagName.length,
        depth,
      });
    }
    const nameBytes = addCandidateBytes(stats, limits, utf8ByteLength(node.tagName));
    if (nameBytes) return nameBytes;

    const rawAttrs = node.attrs ?? [];
    if (rawAttrs.length > limits.maxRawAttrsPerElement) {
      return policyRejection("raw-attrs-exceeded", {
        limit: "maxRawAttrsPerElement",
        limitValue: limits.maxRawAttrsPerElement,
        observed: rawAttrs.length,
        tag: node.tagName.slice(0, 64),
        depth,
      });
    }
    const attrs = [];
    let attrBytes = 0;
    for (const attr of rawAttrs) {
      // Record the qualified name so prefixed attributes (xlink:href) are
      // visible to the policy and rejected there.
      const attrName = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      if (attrName.length > limits.maxRawNameCodeUnits) {
        return policyRejection("raw-name-too-long", {
          limit: "maxRawNameCodeUnits",
          limitValue: limits.maxRawNameCodeUnits,
          observed: attrName.length,
          tag: node.tagName.slice(0, 64),
          attr: attrName.slice(0, 64),
          depth,
        });
      }
      const value = typeof attr.value === "string" ? attr.value : "";
      attrBytes += utf8ByteLength(attrName) + utf8ByteLength(value);
      if (attrBytes > limits.maxRawAttrBytesUtf8PerElement) {
        return policyRejection("raw-attr-bytes-exceeded", {
          limit: "maxRawAttrBytesUtf8PerElement",
          limitValue: limits.maxRawAttrBytesUtf8PerElement,
          observed: attrBytes,
          tag: node.tagName.slice(0, 64),
          depth,
        });
      }
      stats.attrs++;
      attrs.push([attrName, value]);
    }
    const attrOver = addCandidateBytes(stats, limits, attrBytes);
    if (attrOver) return attrOver;

    const ns = node.namespaceURI === NS.html ? "html" : node.namespaceURI === NS.svg ? "svg" : "other";
    const children = [];
    frame.out.push({ kind: "el", ns, tag: node.tagName, attrs, children });
    stack.push({ nodes: childNodesOf(node), index: 0, out: children, depth, pathNodes });
  }

  return { status: "ok", raw: { kind: "root", children: rootChildren }, stats };
}

function addCandidateBytes(stats, limits, bytes) {
  stats.candidateUtf8Bytes += bytes;
  if (stats.candidateUtf8Bytes > limits.maxCandidateUtf8Bytes) {
    return policyRejection("candidate-bytes-exceeded", {
      limit: "maxCandidateUtf8Bytes",
      limitValue: limits.maxCandidateUtf8Bytes,
      observed: stats.candidateUtf8Bytes,
    });
  }
  return null;
}
