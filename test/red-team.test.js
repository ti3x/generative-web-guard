import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlToRaw } from "../src/adapters/parse5.js";
import { checkTree, setClassAllowlist } from "../src/policy.js";
import { RULE_IDS } from "../src/rules.js";
import { CAPABILITIES } from "../src/capabilities-data.js";

const corpus = JSON.parse(readFileSync(new URL("../red-team/corpus.json", import.meta.url), "utf8"));
const knownRules = new Set(RULE_IDS);
const ACTIVE_TAGS = new Set(["script", "style", "iframe", "object", "embed", "applet", "img", "image", "link", "base", "meta", "video", "audio", "source", "track", "form", "a", "animate", "set", "foreignobject"]);
const DANGEROUS_ATTR = /^(?:on|style$|src|href|xlink|xmlns|srcdoc|formaction|action|ping|srcset|background|poster|data$|code$|codebase|manifest|usemap|is$|slot$|nonce$)/i;

setClassAllowlist(["card", "muted", "bar", "btn"]);

function auditTree(tree) {
  const text = [];
  (function walk(node) {
    if (node.kind === "text") text.push(node.text);
    if (node.kind === "el") {
      assert.ok(!ACTIVE_TAGS.has(node.tag.toLowerCase()), `active element survived: ${node.ns}:${node.tag}`);
      for (const [name, value] of node.attrs) {
        assert.ok(!DANGEROUS_ATTR.test(name), `dangerous attribute survived: ${name}`);
        assert.ok(!/javascript:|data:text\/html|https?:\/\/attacker\.invalid/i.test(value), `dangerous value survived: ${name}=${value}`);
      }
    }
    for (const child of node.children ?? []) walk(child);
  })(tree);
  return text.join("");
}

test("red-team corpus metadata is reviewable and linked to known rules", () => {
  assert.equal(corpus.version, 1);
  assert.ok(corpus.cases.length >= 10);
  const ids = new Set();
  for (const entry of corpus.cases) {
    assert.match(entry.id, /^RT-[A-Z]+-\d{3}$/);
    assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.source.url, /^https:\/\//);
    assert.match(entry.source.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.rules.length > 0);
    for (const rule of entry.rules) assert.ok(knownRules.has(rule), `${entry.id}: unknown ${rule}`);
    for (const cve of entry.cves ?? []) assert.match(cve, /^CVE-\d{4}-\d{4,}$/);
  }
});

for (const entry of corpus.cases) {
  test(`red-team ${entry.id}: ${entry.title}`, () => {
    const result = checkTree(parseHtmlToRaw(entry.html));
    assert.equal(result.status, "validated", JSON.stringify(result.reasons));
    const visibleText = auditTree(result.tree);
    for (const expected of entry.mustKeepText) assert.ok(visibleText.includes(expected), `${entry.id}: missing preserved text ${expected}`);
  });
}

// The capability kernel is what makes these constructs unreachable, and it is
// reviewed independently of the corpus. This test links the two: every
// attribute name the corpus audit treats as dangerous, and every element it
// treats as active, must be absent from the reviewed inventory. It holds even
// if no corpus case exercises a given construct.
test("[R-CAP-INVENTORY] the capability inventory excludes every construct the corpus audit treats as dangerous", () => {
  const attrNames = new Set([
    ...Object.keys(CAPABILITIES.attributes.shared),
    ...Object.keys(CAPABILITIES.attributes.html),
    ...Object.keys(CAPABILITIES.attributes.svg),
    ...Object.values(CAPABILITIES.elements.html).flatMap((t) => Object.keys(t)),
    ...Object.values(CAPABILITIES.elements.svg).flatMap((t) => Object.keys(t)),
  ]);
  assert.ok(attrNames.size > 50, "inventory looks empty");
  for (const name of attrNames) {
    assert.ok(!DANGEROUS_ATTR.test(name), `capability inventory permits dangerous attribute ${name}`);
  }
  for (const ns of ["html", "svg"]) {
    for (const tag of Object.keys(CAPABILITIES.elements[ns])) {
      // `svg:text` and `svg:title` are inert text containers; the audit list
      // names active elements only, so nothing in the inventory may match it.
      assert.ok(!ACTIVE_TAGS.has(tag), `capability inventory permits active element ${ns}:${tag}`);
    }
  }
  // And the kernel's own exclusions cover the audit's element list.
  for (const tag of ACTIVE_TAGS) {
    const excluded = CAPABILITIES.excludedElements.html.includes(tag) || CAPABILITIES.excludedElements.svg.includes(tag);
    const absent = !(tag in CAPABILITIES.elements.html) && !(tag in CAPABILITIES.elements.svg);
    assert.ok(excluded || absent, `active element ${tag} is neither excluded nor absent`);
  }
});
