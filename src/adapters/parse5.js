// Parser adapter: parse5 (pinned, non-executing HTML5 parser) to the raw tree
// consumed by checkTree(). Used in Node for tests, the native Lean path, and
// any server-side validation. Output is UNTRUSTED input to the policy.

import { parseFragment } from "parse5";
import { NS } from "../tree.js";

export function parseHtmlToRaw(html) {
  const frag = parseFragment(html);
  return { kind: "root", children: frag.childNodes.map(p5ToRaw) };
}

function p5ToRaw(node) {
  if (node.nodeName === "#text") return { kind: "text", text: node.value };
  if (node.nodeName === "#comment") return { kind: "comment" };
  if (node.nodeName === "#documentType") return { kind: "doctype" };
  if (!node.tagName) return { kind: "unknown" };
  const ns = node.namespaceURI === NS.html ? "html" : node.namespaceURI === NS.svg ? "svg" : "other";
  const attrs = node.attrs.map((a) => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value]);
  let children = node.childNodes ?? [];
  if (node.content && node.content.childNodes) children = children.concat(node.content.childNodes);
  return { kind: "el", ns, tag: node.tagName, attrs, children: children.map(p5ToRaw) };
}
