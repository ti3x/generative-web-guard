// Diagnostic text only. The frame never receives or reparses this string.
// Stop producing output at the cap instead of building an unbounded string.
export function previewTree(tree, cap = 16000) {
  let out = "";
  let truncated = false;
  const append = (value) => {
    if (value.length > cap - out.length) truncated = true;
    out += value.slice(0, cap - out.length);
  };
  const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const stack = [...tree.children].reverse();
  while (stack.length && out.length < cap) {
    const node = stack.pop();
    if (typeof node === "string") { append(node); continue; }
    if (node.kind === "text") { append(escape(node.text)); continue; }
    append(`<${node.tag}`);
    for (const [key, value] of node.attrs) append(` ${key}="${escape(value)}"`);
    append(">");
    if (node.ns === "html" && ["br", "hr", "input"].includes(node.tag)) continue;
    stack.push(`</${node.tag}>`);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return truncated || stack.length ? out.slice(0, cap - 1) + "…" : out;
}
