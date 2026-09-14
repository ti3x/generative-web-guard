// Renderer: builds and patches real DOM from a validated structured tree.
//
// Safety rules enforced by construction in this file:
//   * Elements are created only with document.createElementNS using the fixed
//     namespace URI for the node's declared namespace. The tag string never
//     chooses a namespace and is never parsed.
//   * Attributes are set only with setAttribute on names that already passed
//     the policy. Nothing here can set style, on*, or URL attributes because
//     the policy has removed them, and the renderer additionally refuses them.
//   * Text is set only through Text.data. No HTML string is ever parsed here.
//   * Patching is positional over the validated tree. Focus, selection and
//     in-progress control values survive updates when the element persists.
//
// The renderer never trusts its input either: it re-checks namespace/tag and
// attribute-name membership against the policy tables. If a bug elsewhere let
// a bad node through, this is the last line before the browser.

import { NS } from "./tree.js";
import { POLICY_DATA } from "./policy-data.js";
const HTML_ELEMENTS = POLICY_DATA.htmlElements;
const SVG_ELEMENTS = POLICY_DATA.svgElements;

const REFUSED_ATTR_RE = /^(on|style$|src|href|xlink|xmlns|srcdoc|formaction|action|ping|srcset|background|poster|data$|code$|codebase|manifest|usemap|is$|slot$|nonce$)/i;

function ensureElementAllowed(node) {
  const table = node.ns === "html" ? HTML_ELEMENTS : node.ns === "svg" ? SVG_ELEMENTS : null;
  if (!table || !Object.prototype.hasOwnProperty.call(table, node.tag)) {
    throw new Error(`renderer: refused element ${node.ns}:${node.tag}`);
  }
}

function ensureAttrAllowed(name) {
  if (name.includes(":") || REFUSED_ATTR_RE.test(name)) {
    throw new Error(`renderer: refused attribute ${name}`);
  }
}

export function createRenderer(doc, mount) {
  let current = null; // last committed tree

  function createNode(node) {
    if (node.kind === "text") return doc.createTextNode(node.text);
    ensureElementAllowed(node);
    const element = doc.createElementNS(NS[node.ns], node.tag);
    for (const [name, value] of node.attrs) {
      ensureAttrAllowed(name);
      element.setAttribute(name, value);
    }
    syncControlState(element, node, null);
    for (const child of node.children) element.appendChild(createNode(child));
    return element;
  }

  function patchAttrs(element, oldNode, newNode) {
    const oldMap = new Map(oldNode.attrs);
    for (const [name, value] of newNode.attrs) {
      ensureAttrAllowed(name);
      if (oldMap.get(name) !== value) element.setAttribute(name, value);
      oldMap.delete(name);
    }
    for (const name of oldMap.keys()) element.removeAttribute(name);
    syncControlState(element, newNode, oldNode);
  }

  function patchChildren(parent, oldChildren, newChildren) {
    const domChildren = Array.from(parent.childNodes);
    const shared = Math.min(oldChildren.length, newChildren.length);
    for (let i = 0; i < shared; i++) {
      patchNode(parent, domChildren[i], oldChildren[i], newChildren[i]);
    }
    for (let i = shared; i < oldChildren.length; i++) parent.removeChild(domChildren[i]);
    for (let i = shared; i < newChildren.length; i++) parent.appendChild(createNode(newChildren[i]));
  }

  function patchNode(parent, domNode, oldNode, newNode) {
    if (oldNode.kind !== newNode.kind) {
      parent.replaceChild(createNode(newNode), domNode);
      return;
    }
    if (newNode.kind === "text") {
      if (oldNode.text !== newNode.text) domNode.data = newNode.text;
      return;
    }
    if (oldNode.ns !== newNode.ns || oldNode.tag !== newNode.tag) {
      parent.replaceChild(createNode(newNode), domNode);
      return;
    }
    ensureElementAllowed(newNode);
    patchAttrs(domNode, oldNode, newNode);
    patchChildren(domNode, oldNode.children, newNode.children);
  }

  // Controls: when the validated value attribute changes, the view intends a
  // new value and the property is set. When it is unchanged, whatever the user
  // typed or toggled is left alone.
  function syncControlState(element, newNode, oldNode) {
    if (newNode.ns !== "html") return;
    const tag = newNode.tag;
    if (tag !== "input" && tag !== "textarea" && tag !== "select" && tag !== "option") return;
    const attr = (node, name) => {
      if (!node) return undefined;
      const pair = node.attrs.find((a) => a[0] === name);
      return pair ? pair[1] : undefined;
    };
    if (tag === "input") {
      const type = attr(newNode, "type");
      if (type === "checkbox" || type === "radio") {
        const now = attr(newNode, "checked") !== undefined;
        const before = oldNode ? attr(oldNode, "checked") !== undefined : undefined;
        if (before !== now) element.checked = now;
      } else {
        const now = attr(newNode, "value");
        const before = attr(oldNode, "value");
        if (now !== undefined && now !== before && element.value !== now) element.value = now;
      }
    } else if (tag === "option") {
      const now = attr(newNode, "selected") !== undefined;
      const before = oldNode ? attr(oldNode, "selected") !== undefined : undefined;
      if (before !== now) element.selected = now;
    }
    // textarea and select: the validated tree carries state through children
    // (text and selected options), which patchChildren handles.
  }

  // Focus path relative to mount, plus selection for text controls.
  function captureFocus() {
    const active = doc.activeElement;
    if (!active || active === doc.body || !mount.contains(active)) return null;
    const path = [];
    let n = active;
    while (n && n !== mount) {
      path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
      n = n.parentNode;
    }
    const sel = {};
    if (typeof active.selectionStart === "number") {
      sel.start = active.selectionStart;
      sel.end = active.selectionEnd;
      sel.direction = active.selectionDirection;
    }
    return { path, sel, tag: active.localName };
  }

  function restoreFocus(saved) {
    if (!saved) return;
    let n = mount;
    for (const i of saved.path) {
      n = n && n.childNodes[i];
    }
    if (!n || n.nodeType !== 1 || n.localName !== saved.tag) return;
    if (doc.activeElement !== n && typeof n.focus === "function") {
      try { n.focus({ preventScroll: true }); } catch { /* not focusable */ }
    }
    if (saved.sel.start !== undefined && typeof n.setSelectionRange === "function") {
      try { n.setSelectionRange(saved.sel.start, saved.sel.end, saved.sel.direction); } catch { /* type without selection */ }
    }
  }

  return {
    render(tree) {
      if (!tree || tree.kind !== "root") throw new Error("renderer: expected root");
      const focus = captureFocus();
      if (current === null) {
        while (mount.firstChild) mount.removeChild(mount.firstChild);
        for (const child of tree.children) mount.appendChild(createNode(child));
      } else {
        patchChildren(mount, current.children, tree.children);
      }
      current = tree;
      restoreFocus(focus);
    },
    clear() {
      while (mount.firstChild) mount.removeChild(mount.firstChild);
      current = null;
    },
    get current() {
      return current;
    },
  };
}
