// Behavioral evidence separate from rule tags and cross-engine agreement.
// The safety oracle deliberately does not import policy tables/validators.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEngines, DEFAULT_CLASSES, firstDiff } from "./lib/engines.mjs";
import { parseHtmlToRaw } from "../src/adapters/parse5.js";
import { CORPUS, randomHtml, rng } from "./lean-differential.mjs";

const redTeamCases = JSON.parse(readFileSync(new URL("../red-team/corpus.json", import.meta.url), "utf8")).cases;

const forbiddenTags = new Set(["script", "style", "iframe", "frame", "object", "embed", "applet", "img", "link", "meta", "base", "form", "a", "math", "foreignobject", "image", "use", "animate", "set", "animatetransform", "animatemotion", "template"]);
const forbiddenAttr = /^(?:on|style$|src|href|xlink|xmlns|srcdoc|formaction|action$|ping$|background$|poster$|name$|__proto__$|constructor$|prototype$)/i;
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
const root = children => ({ kind: "root", children });
const el = (tag, attrs = [], children = [], ns = "html") => ({ kind: "el", ns, tag, attrs, children });
const text = s => ({ kind: "text", text: s });

export function assertSafeTree(tree, { classes = DEFAULT_CLASSES } = {}) {
  assert.equal(tree.kind, "root");
  let count = 0, total = 0;
  function walk(nodes, parent, depth) {
    for (const node of nodes) {
      assert.ok(++count <= 5000, "node bound");
      if (node.kind === "text") {
        assert.ok(node.text.length > 0 && node.text.length <= 20000, "text bound");
        assert.ok(!controls.test(node.text), "text control characters");
        total += node.text.length;
        assert.ok(total <= 200000, "total text bound");
        continue;
      }
      assert.equal(node.kind, "el");
      assert.ok(depth + 1 <= 32, "depth bound");
      assert.ok(!forbiddenTags.has(node.tag.toLowerCase()), `forbidden element ${node.tag}`);
      assert.ok(node.ns === "html" || node.ns === "svg", "namespace");
      assert.ok(node.ns === "html" ? parent === "html" : parent === "svg" || node.tag === "svg", "namespace transition");
      if (node.ns === "svg" && ["title", "desc"].includes(node.tag)) assert.ok(node.children.every(n => n.kind === "text"), "text-only SVG context");
      assert.ok(node.attrs.length <= 24, "attribute bound");
      const names = node.attrs.map(([n]) => n);
      assert.deepEqual(names, [...new Set(names)].sort(), "unique sorted attributes");
      const attrs = new Map(node.attrs);
      for (const [name, value] of node.attrs) {
        assert.ok(!forbiddenAttr.test(name), `forbidden attribute ${name}`);
        assert.ok(!controls.test(value), "attribute control characters");
        if (name === "id") assert.match(value, /^g-[A-Za-z][A-Za-z0-9_-]{0,63}$/);
        if (name === "class") assert.ok(value.split(" ").every(v => classes.includes(v)), "class membership");
        if (name === "fill" || name === "stroke") assert.ok(!/url\s*\(|expression|[;{}]/i.test(value), "paint resource or code");
      }
      if (node.ns === "html") {
        if (node.tag === "button") assert.equal(attrs.get("type"), "button");
        if (["input", "select", "textarea"].includes(node.tag)) assert.equal(attrs.get("autocomplete"), "off");
        if (node.tag === "input") assert.ok(["text", "number", "range", "checkbox", "radio", "search"].includes(attrs.get("type")), "input type");
      }
      walk(node.children, node.ns, depth + 1);
    }
  }
  walk(tree.children, "html", 0);
}

const benign = root([el("div", [["class", "card"], ["id", "g-example"]], [text("A & B"), el("svg", [["viewBox", "0 0 100 50"]], [el("circle", [["fill", "red"], ["r", "2"]], [], "svg")], "svg")])]);

export async function checkProperties(engines) {
  // Known expected output prevents "reject everything" and "delete all
  // content" implementations from passing the negative assertions.
  for (const engine of engines) {
    const [answer] = await engine.run([parseHtmlToRaw('<div class="card" id="example">A &amp; B<svg viewBox="0 0 100 50"><circle fill="red" r="02.00"></circle></svg></div>')]);
    assert.equal(answer.status, "validated", `${engine.name}: benign rejected`);
    assert.deepEqual(answer.tree, benign, `${engine.name}: benign content changed`);
  }
  const raws = CORPUS.map(parseHtmlToRaw);
  for (const seed of [1, 7, 91]) {
    const random = rng(seed);
    for (let i = 0; i < 100; i++) raws.push(parseHtmlToRaw(randomHtml(random)));
  }
  const redTeamStart = raws.length;
  raws.push(...redTeamCases.map((entry) => parseHtmlToRaw(entry.html)));
  // Direct raw trees exercise properties hidden by HTML parser repairs.
  raws.push(root(Array.from({ length: 5001 }, () => text("x"))));
  raws.push(root([el("div", [["onclick", "x"], ["id", "x"]])]));
  raws.push(root([el("svg", [], [el("desc", [], [el("div", [], [text("x")])], "svg")], "svg")]));
  let baseline = null;
  for (const engine of engines) {
    const outputs = [];
    for (let i = 0; i < raws.length; i += 25) outputs.push(...await engine.run(raws.slice(i, i + 25)));
    assert.equal(outputs.length, raws.length);
    if (baseline) outputs.forEach((o, i) => assert.equal(firstDiff(baseline[i], o), null, `${engine.name}: case ${i}`));
    else baseline = outputs;
    const accepted = outputs.filter(o => o.status === "validated");
    for (const o of accepted) assertSafeTree(o.tree);
    redTeamCases.forEach((entry, index) => {
      const output = outputs[redTeamStart + index];
      assert.equal(output.status, "validated", `${engine.name}: ${entry.id} rejected`);
      const textContent = [];
      (function collect(node) {
        if (node.kind === "text") textContent.push(node.text);
        for (const child of node.children ?? []) collect(child);
      })(output.tree);
      for (const expected of entry.mustKeepText) {
        assert.ok(textContent.join("").includes(expected), `${engine.name}: ${entry.id} lost ${expected}`);
      }
    });
    for (let i = 0; i < accepted.length; i += 25) {
      const chunk = accepted.slice(i, i + 25);
      const replay = await engine.run(chunk.map(o => o.tree));
      replay.forEach((o, j) => {
        assert.equal(o.status, "validated", `${engine.name}: replay rejected`);
        assert.deepEqual(o.tree, chunk[j].tree, `${engine.name}: replay changed tree`);
        assert.equal(o.changes, 0, `${engine.name}: replay emitted changes`);
      });
    }
    assert.equal(outputs[raws.length - 3].status, "rejected", "text-node budget must reject");
    console.log(`properties: ${engine.name}, ${raws.length} cases, ${accepted.length} fixed points`);
  }
  await checkStrictDecoderDivergence(engines);
}

/**
 * Inputs where the PRODUCTION ABI is deliberately stricter than the candidate
 * builder, and the difference is a contract rather than a bug.
 *
 * The Wasm engine speaks the versioned single-document ABI, whose decoder is
 * strict: it refuses rather than repairs. `src/policy.js` and the native batch
 * interface both use lenient decoding -- `Guard.rawFromJson` drops malformed
 * attribute entries and resolves a duplicate name to the first occurrence --
 * so on these inputs they validate while the ABI refuses.
 *
 * parse5 never produces a duplicate attribute name (the HTML parsing spec
 * drops them in a start tag), so no parsed document is affected; these are
 * hand-built raw trees. The reason to refuse is that "which duplicate wins" is
 * a silent resolution inside an authority, and an authority should not resolve
 * ambiguity it can reject.
 *
 * This is asserted rather than excluded, so if the ABI ever silently starts
 * accepting one of these, the check fails.
 */
async function checkStrictDecoderDivergence(engines) {
  const cases = [
    ["duplicate attribute name", root([el("div", [["id", "x"], ["id", "y"]])]), /duplicate-attribute:id/],
    ["duplicate class attribute", root([el("p", [["class", "card"], ["class", "muted"]])]), /duplicate-attribute:class/],
  ];
  for (const engine of engines) {
    for (const [label, raw, pattern] of cases) {
      const [out] = engine.name === "wasm"
        ? await engine.checkCandidates([raw]) : await engine.run([raw]);
      if (engine.name === "wasm") {
        assert.equal(out.status, "error", `${engine.name}: ${label} must be refused by the strict ABI decoder`);
        assert.match(out.reason.detail, pattern, `${engine.name}: ${label} refused for the wrong reason`);
      } else {
        assert.equal(out.status, "validated", `${engine.name}: ${label} is resolved leniently, not refused`);
      }
    }
    console.log(`strict-decoder divergence: ${engine.name}, ${cases.length} cases behave as documented`);
  }
}

function negativeControls() {
  const faults = [
    root([el("script", [], [text("alert(1)")])]),
    root([el("p", [["onclick", "x"]])]),
    root([el("p", [["href", "https://x.invalid"]])]),
    root([el("div", [["id", "root"]])]),
    root([el("input", [["autocomplete", "on"], ["type", "password"]])]),
    root([el("svg", [], [el("div")], "svg")]),
    root(Array.from({ length: 5001 }, () => text("x"))),
  ];
  assertSafeTree(benign);
  for (const faulty of faults) assert.throws(() => assertSafeTree(faulty));
  console.log(`oracle negative controls: caught ${faults.length} deliberately unsafe outputs`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  negativeControls();
  await assert.rejects(() => checkProperties([{ name: "reject-all fault", run: async () => [{ status: "rejected" }] }]));
  await assert.rejects(() => checkProperties([{ name: "erase-content fault", run: async () => [{ status: "validated", tree: root([]), changes: 0 }] }]));
  console.log("positive controls: reject-all and erase-content faults detected");
  await checkProperties(await loadEngines());
}
