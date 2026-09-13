// COMPATIBILITY-ONLY parser adapter: inert DOM (DOMParser in a browser, jsdom
// in tests) to the raw tree consumed by checkTree().
//
// parse5 (src/adapters/parse5.js) is the production frontend and the demos and
// the policy Worker use it. This adapter is retained only so that parser
// differentials between DOMParser and parse5 can be tested explicitly
// (test/preprocess.test.js). Do not wire it into a rendering path.
//
// Everything produced here is UNTRUSTED input to the policy. The adapter does
// no filtering of its own; it only records namespace, tag, attributes and
// children faithfully so the policy sees what the parser saw.
//
// R3. Conversion is iterative and bounded by the same limits and the same
// structured rejection as the parse5 adapter, so a deeply nested document
// cannot overflow the stack here either.

import { NS } from "../tree.js";
import { PREPROCESS_LIMITS, policyRejection, utf8ByteLength } from "../policy-protocol.js";
import { PreprocessLimitError } from "./parse5.js";

/**
 * @returns {{status:"ok", raw: object, stats: object}
 *          |{status:"rejected", reason: object}}
 */
export function preprocessHtmlWithDom(html, DOMParserImpl, options = {}) {
  const limits = options.limits ? { ...PREPROCESS_LIMITS, ...options.limits } : PREPROCESS_LIMITS;
  const now = options.now ?? Date.now;
  if (typeof html !== "string") return policyRejection("source-not-a-string");
  if (html.length > limits.maxSourceCodeUnits) {
    return policyRejection("source-too-long", {
      limit: "maxSourceCodeUnits",
      limitValue: limits.maxSourceCodeUnits,
      observed: html.length,
    });
  }
  let doc;
  try {
    doc = new DOMParserImpl().parseFromString(html, "text/html");
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    return policyRejection("parser-failed", { detail: message.slice(0, 200) });
  }
  return convert(doc.body, limits, now);
}

/** Compatibility wrapper: throws PreprocessLimitError on a bounded rejection. */
export function parseHtmlToRaw(html, DOMParserImpl, options) {
  const result = preprocessHtmlWithDom(html, DOMParserImpl, options);
  if (result.status === "rejected") throw new PreprocessLimitError(result.reason);
  return result.raw;
}

function childNodesOf(node) {
  const children = Array.from(node.childNodes ?? []);
  if (node.content && node.content.childNodes) {
    return children.concat(Array.from(node.content.childNodes));
  }
  return children;
}

function convert(body, limits, now) {
  const deadline = now() + limits.maxPreprocessMs;
  const stats = { rawNodes: 0, rawDepth: 0, rawPathNodes: 0, commentNodes: 0, attrs: 0, textCodeUnits: 0, candidateUtf8Bytes: 0 };
  const rootChildren = [];
  const stack = [{ nodes: childNodesOf(body), index: 0, out: rootChildren, depth: 0, pathNodes: 0 }];
  let ticks = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
    const position = ++frame.index; // 1-based, among this node's siblings
    const node = frame.nodes[position - 1];

    if ((++ticks & 0x3ff) === 0 && now() > deadline) {
      return policyRejection("preprocess-budget-exceeded", {
        limit: "maxPreprocessMs", limitValue: limits.maxPreprocessMs, observed: stats.rawNodes,
      });
    }
    if (++stats.rawNodes > limits.maxRawNodes) {
      return policyRejection("raw-nodes-exceeded", {
        limit: "maxRawNodes", limitValue: limits.maxRawNodes, observed: stats.rawNodes, depth: frame.depth,
      });
    }
    // Raw nodes open at once in the walk; see the parse5 adapter and
    // src/policy-protocol.js (maxRawPathNodes).
    const pathNodes = frame.pathNodes + position;
    if (pathNodes > limits.maxRawPathNodes) {
      return policyRejection("raw-path-nodes-exceeded", {
        limit: "maxRawPathNodes", limitValue: limits.maxRawPathNodes, observed: pathNodes, depth: frame.depth,
      });
    }
    if (pathNodes > stats.rawPathNodes) stats.rawPathNodes = pathNodes;

    if (node.nodeType === 3) {
      const value = typeof node.data === "string" ? node.data : "";
      if (value.length > limits.maxRawTextCodeUnits) {
        return policyRejection("raw-text-too-long", {
          limit: "maxRawTextCodeUnits", limitValue: limits.maxRawTextCodeUnits, observed: value.length,
        });
      }
      stats.textCodeUnits += value.length;
      if (stats.textCodeUnits > limits.maxRawTotalTextCodeUnits) {
        return policyRejection("raw-total-text-too-long", {
          limit: "maxRawTotalTextCodeUnits", limitValue: limits.maxRawTotalTextCodeUnits, observed: stats.textCodeUnits,
        });
      }
      const over = addBytes(stats, limits, utf8ByteLength(value));
      if (over) return over;
      frame.out.push({ kind: "text", text: value });
      continue;
    }

    if (node.nodeType !== 1) {
      if (++stats.commentNodes > limits.maxRawCommentNodes) {
        return policyRejection("raw-comment-nodes-exceeded", {
          limit: "maxRawCommentNodes", limitValue: limits.maxRawCommentNodes, observed: stats.commentNodes,
        });
      }
      frame.out.push({ kind: node.nodeType === 8 ? "comment" : node.nodeType === 10 ? "doctype" : "unknown" });
      continue;
    }

    const depth = frame.depth + 1;
    if (depth > limits.maxRawDepth) {
      return policyRejection("raw-depth-exceeded", {
        limit: "maxRawDepth", limitValue: limits.maxRawDepth, observed: depth, tag: String(node.localName).slice(0, 64),
      });
    }
    if (depth > stats.rawDepth) stats.rawDepth = depth;

    const tag = node.localName;
    if (tag.length > limits.maxRawNameCodeUnits) {
      return policyRejection("raw-name-too-long", {
        limit: "maxRawNameCodeUnits", limitValue: limits.maxRawNameCodeUnits, observed: tag.length, depth,
      });
    }
    const nameOver = addBytes(stats, limits, utf8ByteLength(tag));
    if (nameOver) return nameOver;

    const attributes = Array.from(node.attributes ?? []);
    if (attributes.length > limits.maxRawAttrsPerElement) {
      return policyRejection("raw-attrs-exceeded", {
        limit: "maxRawAttrsPerElement", limitValue: limits.maxRawAttrsPerElement,
        observed: attributes.length, tag: String(tag).slice(0, 64), depth,
      });
    }
    const attrs = [];
    let attrBytes = 0;
    for (const attribute of attributes) {
      if (attribute.name.length > limits.maxRawNameCodeUnits) {
        return policyRejection("raw-name-too-long", {
          limit: "maxRawNameCodeUnits", limitValue: limits.maxRawNameCodeUnits,
          observed: attribute.name.length, attr: attribute.name.slice(0, 64), depth,
        });
      }
      attrBytes += utf8ByteLength(attribute.name) + utf8ByteLength(attribute.value);
      if (attrBytes > limits.maxRawAttrBytesUtf8PerElement) {
        return policyRejection("raw-attr-bytes-exceeded", {
          limit: "maxRawAttrBytesUtf8PerElement", limitValue: limits.maxRawAttrBytesUtf8PerElement,
          observed: attrBytes, tag: String(tag).slice(0, 64), depth,
        });
      }
      stats.attrs++;
      attrs.push([attribute.name, attribute.value]);
    }
    const attrOver = addBytes(stats, limits, attrBytes);
    if (attrOver) return attrOver;

    const ns = node.namespaceURI === NS.html ? "html" : node.namespaceURI === NS.svg ? "svg" : "other";
    const children = [];
    frame.out.push({ kind: "el", ns, tag, attrs, children });
    stack.push({ nodes: childNodesOf(node), index: 0, out: children, depth, pathNodes });
  }

  return { status: "ok", raw: { kind: "root", children: rootChildren }, stats };
}

function addBytes(stats, limits, bytes) {
  stats.candidateUtf8Bytes += bytes;
  if (stats.candidateUtf8Bytes > limits.maxCandidateUtf8Bytes) {
    return policyRejection("candidate-bytes-exceeded", {
      limit: "maxCandidateUtf8Bytes", limitValue: limits.maxCandidateUtf8Bytes, observed: stats.candidateUtf8Bytes,
    });
  }
  return null;
}
