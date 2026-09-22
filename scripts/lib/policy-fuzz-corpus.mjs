import { readFileSync, readdirSync } from "node:fs";
import { generateMessages } from "@cucumber/gherkin";
import { SourceMediaType, IdGenerator } from "@cucumber/messages";
import { CORPUS, randomHtml, rng } from "../lean-differential.mjs";
import { PREPROCESS_LIMITS as L } from "../../src/policy-protocol.js";
import { checkRequest, LEAN_ABI_VERSION } from "../../src/lean-abi.js";

export const redTeam = JSON.parse(readFileSync(new URL("../../red-team/corpus.json", import.meta.url))).cases;
export function seedCorpus() {
  const cases = [
    ...redTeam.map(c => ({ label: c.id, html: c.html, mustKeepText: c.mustKeepText, mustAccept: true })),
    ...CORPUS.map((html, i) => ({ label: `differential-${i}`, html })),
  ];
  for (const file of readdirSync(new URL("../../features/", import.meta.url)).filter(f => f.endsWith(".feature")).sort()) {
    const envelopes = generateMessages(readFileSync(new URL(`../../features/${file}`, import.meta.url), "utf8"), file,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, { includePickles: true, newId: IdGenerator.incrementing() });
    for (const e of envelopes) {
      if (e.parseError) throw new Error(`${file}: ${e.parseError.message}`);
      if (!e.pickle) continue;
      for (const step of e.pickle.steps) {
        if (/^the generated HTML/.test(step.text) && step.argument?.docString) {
          cases.push({ label: `bdd:${file}:${e.pickle.name}`, html: step.argument.docString.content });
        }
      }
    }
  }
  return cases;
}

// Source-reachable limits and diagnostic budgets. Some backstops are masked by
// tighter source/path limits; report the actual refusal instead of claiming a
// larger, unreachable limit was exercised.
export function boundaryCorpus() {
  const shapes = [
    ["maxSourceCodeUnits", n => " ".repeat(n)],
    ["maxRawDepth", n => "<x>".repeat(n) + "x" + "</x>".repeat(n)],
    ["maxRawPathNodes", n => "<span></span>".repeat(n)],
    ["maxRawNodes", n => { const group = 50, full = Math.floor(n / group), rest = n % group; return ("<div>" + "<span></span>".repeat(group - 1) + "</div>").repeat(full) + "<span></span>".repeat(rest); }],
    ["maxRawCommentNodes", n => "<!--x-->".repeat(n)],
    ["maxRawAttrsPerElement", n => `<p ${Array.from({ length: n }, (_, i) => `a${i}="x"`).join(" ")}>kept</p>`],
    ["maxRawAttrBytesUtf8PerElement", n => `<p title="${"a".repeat(Math.max(0, n - 5))}">kept</p>`],
    ["maxRawNameCodeUnits", n => `<${"a".repeat(n)}>x</${"a".repeat(n)}>`],
    ["maxRawTextCodeUnits", n => `<p>${"x".repeat(n)}</p>`],
    ["maxRawTotalTextCodeUnits", n => ("<p>" + "x".repeat(10000) + "</p>").repeat(Math.floor(n / 10000)) + "x".repeat(n % 10000)],
    ["maxCandidateUtf8Bytes", n => "<p>" + "&".repeat(n) + "</p>"],
    ["maxDiagnosticRecords", n => "<p onclick=x>x</p>".repeat(n)],
    ["maxDiagnosticsUtf8Bytes", n => `<p ${Array.from({ length: 240 }, (_, i) => `a${i}="${"x".repeat(Math.floor(n / 240))}"`).join(" ")}>x</p>`],
    ["maxDetailCodeUnits", n => `<${"a".repeat(n)}>x</${"a".repeat(n)}>`],
  ];
  return shapes.flatMap(([limit, build]) => [-1, 0, 1].map(delta => ({ label: `${limit}${delta < 0 ? "-1" : delta ? "+1" : ""}`, limit, html: build(L[limit] + delta) })));
}

export function policyCases(seed = 1) {
  const random = rng(seed), corpus = [...seedCorpus(), ...boundaryCorpus()];
  const pick = xs => xs[Math.floor(random() * xs.length)];
  return index => {
    if (index < corpus.length) return { ...corpus[index], op: "pipeline" };
    const base = pick(corpus.slice(0, Math.min(corpus.length, 100)));
    const at = Math.floor(random() * (base.html.length + 1));
    const inserted = pick(["<!--", "-->", "</textarea>", "<svg><desc>", "&amp;", "&#0;", "\0", "\ud800", "<table><tr><td>", "<b><i></b>", '" onload="x', "<template>", "<noscript>"]);
    const mutation = index % 5;
    const html = mutation === 0 ? randomHtml(random)
      : mutation === 1 ? base.html.slice(0, at) + inserted + base.html.slice(at)
      : mutation === 2 ? base.html.slice(0, at) + base.html.slice(at + 1 + Math.floor(random() * 30))
      : mutation === 3 ? base.html.slice(0, at) + base.html.slice(0, at) + base.html.slice(at)
      : `<p>preserved-${index}</p>` + base.html;
    return { op: "pipeline", label: `mutate:${base.label}:${mutation}`, html,
      ...(mutation === 4 ? { mustKeepText: [`preserved-${index}`] } : {}) };
  };
}

export const benignTree = { kind: "root", children: [{ kind: "el", ns: "html", tag: "p", attrs: [], children: [{ kind: "text", text: "benign-control" }] }] };
export function abiCases(seed = 1, limits = {}) {
  const random = rng(seed), envelope = document => checkRequest("fuzz", document);
  const base = envelope(benignTree);
  const invalid = (label, text, expected = "error") => ({ op: "abi", label, text, expected });
  const cases = [
    { op: "abi", label: "canonical-control", text: base, expected: "accepted" },
    invalid("unknown-envelope-field", base.replace('{"abi":', '{"unknown":1,"abi":')),
    invalid("duplicate-envelope-key", base.replace('{"abi":', `{"abi":${LEAN_ABI_VERSION},"abi":`)),
    invalid("wrong-type", base.replace('"requestId":"fuzz"', '"requestId":null')),
    invalid("nested-root", envelope({ kind: "root", children: [{ kind: "root", children: [] }] })),
    invalid("extra-node-field", envelope({ ...benignTree, extra: true })),
    invalid("duplicate-node-key", base.replace('"kind":"root"', '"kind":"root","kind":"root"')),
    invalid("duplicate-attribute", envelope({ kind: "root", children: [{ kind: "el", ns: "html", tag: "p", attrs: [["title", "a"], ["title", "b"]], children: [] }] })),
    invalid("wrong-namespace", base.replace('"ns":"html"', '"ns":"math"')),
    invalid("long-request-id", base.replace('"fuzz"', JSON.stringify("x".repeat(129)))),
    invalid("malformed-json", base.slice(0, -1)),
    ...[[0x80], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf5, 0x80, 0x80, 0x80]].map((bytes, i) => ({ op: "abi", label: `invalid-utf8-${i}`, bytes, expected: "shim:-3" })),
    { op: "abi", label: "capacity-plus-one", text: "", length: 2200001, expected: "shim:-2" },
    { op: "abi", label: "negative-length", text: "", length: -1, expected: "shim:-2" },
    ...[-1, 0, 1].map(delta => {
      let node = { kind: "text", text: "x" };
      const depth = (limits.maxRawDepth ?? 256) + delta;
      for (let i = 0; i < depth; i++) node = { kind: "el", ns: "html", tag: "div", attrs: [], children: [node] };
      return invalid(`decoder-depth:${depth}`, envelope({ kind: "root", children: [node] }), delta > 0 ? "error" : "nonaccepted");
    }),
  ];
  return index => {
    if (index < cases.length) return cases[index];
    const text = "x".repeat(Math.floor(random() * 2000)) + ["😀", "\0", "\ud800", "\u202e"][index % 4];
    const tree = structuredClone(benignTree);
    tree.children[0].children[0].text = text;
    const raw = envelope(tree);
    if (index % 3 === 0) return invalid(`unknown-key-${index}`, raw.replace('{"kind":"text"', `{"unexpected${index}":true,"kind":"text"`));
    if (index % 3 === 1) return invalid(`duplicate-key-${index}`, raw.replace('{"kind":"text"', '{"kind":"text","kind":"text"'));
    return { op: "abi", label: `unicode-${index}`, text: raw, expected: "valid" };
  };
}
