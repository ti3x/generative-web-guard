// Parser adapter: inert DOM (from DOMParser in a browser, or jsdom in tests)
// to the raw tree consumed by checkTree(). Documents created by DOMParser do
// not run scripts or load subresources, so this is a non-executing frontend.
//
// Everything produced here is UNTRUSTED input to the policy. The adapter does
// no filtering of its own; it only records namespace, tag, attributes and
// children faithfully so the policy sees what the parser saw.

import { NS } from "../tree.js";

export function parseHtmlToRaw(html, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(html, "text/html");
  return { kind: "root", children: Array.from(doc.body.childNodes).map(domToRaw) };
}

export function domToRaw(node) {
  switch (node.nodeType) {
    case 3: // TEXT_NODE
      return { kind: "text", text: node.data };
    case 1: { // ELEMENT_NODE
      const ns = node.namespaceURI === NS.html ? "html" : node.namespaceURI === NS.svg ? "svg" : "other";
      const attrs = [];
      for (const a of Array.from(node.attributes)) {
        // Record the qualified name so prefixed attributes (xlink:href) are
        // visible to the policy and rejected there.
        attrs.push([a.name, a.value]);
      }
      let children = Array.from(node.childNodes);
      // <template> content lives in a separate fragment; surface it so the
      // policy can see and drop it rather than silently keeping an empty shell.
      if (node.content && node.content.childNodes) {
        children = children.concat(Array.from(node.content.childNodes));
      }
      return { kind: "el", ns, tag: node.localName, attrs, children: children.map(domToRaw) };
    }
    case 8: // COMMENT_NODE
      return { kind: "comment" };
    case 10: // DOCUMENT_TYPE_NODE
      return { kind: "doctype" };
    default:
      return { kind: "unknown" };
  }
}
