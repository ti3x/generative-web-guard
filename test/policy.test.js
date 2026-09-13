import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseHtmlToRaw as p5 } from "../src/adapters/parse5.js";
import { parseHtmlToRaw as domParse } from "../src/adapters/dom.js";
import { checkTree, isValidated, setClassAllowlist } from "../src/policy.js";
import { LIMITS, isTreeShaped } from "../src/tree.js";
import { readFileSync } from "node:fs";
import { validatePolicy, loadCapabilities } from "../scripts/gen-policy.mjs";
import { CAPABILITIES, CAPABILITY_VERSION, CAPABILITY_RULES } from "../src/capabilities-data.js";
import { RULE_IDS } from "../src/rules.js";

setClassAllowlist(["card", "muted", "bar", "btn"]);

const { window } = new JSDOM("");
const check = (html) => checkTree(p5(html));
const ok = (html) => {
  const r = check(html);
  assert.equal(r.status, "validated", JSON.stringify(r));
  return r;
};

// Recursively collect every element (ns:tag) and attribute name in a tree.
function collect(tree) {
  const tags = [], attrs = [];
  (function walk(n) {
    if (n.kind === "el") {
      tags.push(`${n.ns}:${n.tag}`);
      for (const [k] of n.attrs) attrs.push(k);
    }
    (n.children || []).forEach(walk);
  })(tree);
  return { tags, attrs };
}

function serialize(tree) {
  // Debug helper only. Never used for rendering.
  return JSON.stringify(tree);
}

test("[R-EXEC-SCRIPT, R-STYLE-ELEMENT, R-RES-ELEMENT, R-EXEC-HANDLER] script, style, iframe and handlers are removed", () => {
  const r = ok(`<div class="card" onclick="x()"><script>alert(1)</script><style>@import url(x)</style><iframe src=x></iframe><p>hi</p></div>`);
  const { tags, attrs } = collect(r.tree);
  assert.deepEqual(tags, ["html:div", "html:p"]);
  assert.deepEqual(attrs, ["class"]);
  assert.ok(r.changes.some((c) => c.kind === "removed-element" && c.tag === "script"));
  assert.ok(r.changes.some((c) => c.kind === "removed-attribute" && c.name === "onclick"));
});

test("[R-NAV-ANCHOR, R-NAV-FORM, R-CTRL-BUTTON-TYPE] anchors and forms are unwrapped, their text kept, URLs gone", () => {
  const r = ok(`<a href="https://x/" target="_blank">link</a><form action="https://x/"><button>Go</button></form>`);
  const { tags, attrs } = collect(r.tree);
  assert.deepEqual(tags, ["html:button"]);
  assert.ok(!attrs.includes("href") && !attrs.includes("action"));
  assert.ok(serialize(r.tree).includes("link"));
  // button type is forced to "button"
  assert.deepEqual(r.tree.children[1].attrs, [["type", "button"]]);
});

test("[R-RES-URL-ATTR, R-RES-ELEMENT, R-RES-SVG-REF] every url-valued attribute and every element that can fetch is gone", () => {
  const html = `
    <img src="https://x/a.png" srcset="https://x/b.png 2x">
    <video poster="https://x/p.png" src="https://x/v.mp4"></video>
    <audio src="x"></audio><source src="x"><track src="x"><picture></picture>
    <object data="x"></object><embed src="x"><applet code="x"></applet>
    <link rel="stylesheet" href="x"><base href="x"><meta http-equiv="refresh" content="0;url=x">
    <input type="image" src="x"><button formaction="x">b</button>
    <table background="x"><tr><td background="x">c</td></tr></table>
    <a ping="x" href="x">a</a>
    <div style="background:url(x)">s</div>
    <svg><image href="x"></image><use href="#a"></use><feImage href="x"></feImage>
      <textPath href="#p">t</textPath><a href="x"><text>svg a</text></a>
      <rect fill="url(#g)" stroke="url(x)" filter="url(#f)" mask="url(#m)" clip-path="url(#c)" width="1" height="1"></rect>
      <script href="x"></script><animate attributeName="x"></animate><set></set>
    </svg>`;
  const r = ok(html);
  const { tags, attrs } = collect(r.tree);
  const bad = /^(src|href|srcset|poster|data|code|background|formaction|ping|style|fill|stroke|filter|mask|clip-path|content|http-equiv|rel|xlink)/;
  assert.deepEqual(attrs.filter((a) => bad.test(a)), []);
  for (const t of tags) {
    assert.ok(!/img|video|audio|source|track|picture|object|embed|applet|link|base|meta|image|use|feimage|textpath|script|animate|set|^svg:a$/.test(t), t);
  }
  assert.ok(!serialize(r.tree).includes("https://x/"));
});

test("[R-NS-POSITION] SVG integration points cannot smuggle HTML", () => {
  // <desc>, <title> and <foreignObject> switch the parser back to HTML.
  const r = ok(`<svg><desc><img src=x onerror=alert(1)></desc><title><b>t</b></title><foreignObject><img src=x></foreignObject></svg>`);
  const { tags, attrs } = collect(r.tree);
  assert.deepEqual(tags, ["svg:svg", "svg:desc", "svg:title"]);
  assert.deepEqual(attrs, []);
});

test("[R-NS-MATHML] MathML and unknown namespaces are dropped with their children", () => {
  const r = ok(`<math><mi>x</mi><annotation-xml encoding="text/html"><script>1</script></annotation-xml></math><p>after</p>`);
  assert.deepEqual(collect(r.tree).tags, ["html:p"]);
});

test("[R-NS-POSITION, R-STRUCT-ELEMENT-ALLOWLIST] svg elements outside an svg root, and html inside svg, are dropped", () => {
  // The HTML parser closes the <svg> when it meets <div>, so the later <g>
  // becomes an unknown HTML element and is dropped as well.
  const r = ok(`<div><rect width="1" height="1"></rect></div><svg><div>x</div><g></g></svg>`);
  assert.deepEqual(collect(r.tree).tags, ["html:div", "svg:svg", "html:div"]);
  // <rect> inside <div> is parsed as an unknown HTML element, not SVG.
  assert.ok(r.changes.some((c) => c.kind === "removed-element" && c.tag === "rect"));
  assert.ok(r.changes.some((c) => c.kind === "removed-element" && c.tag === "g"));
});

test("[R-RCDATA-TEMPLATE] template contents are visible to the policy and dropped", () => {
  const r = ok(`<template><script>1</script></template><p>a</p>`);
  assert.deepEqual(collect(r.tree).tags, ["html:p"]);
});

test("[R-VAL-NUMBER, R-VAL-PATH] numeric geometry is bounded and canonical; exponents rejected", () => {
  const r = ok(`<svg viewBox="0 0 100 50"><rect x="1e999" y="NaN" width="10.50" height="-5" rx="Infinity"></rect><circle r="99999999" cx="1" cy="2"></circle><path d="M 0 0 L 10 10 Z"></path><path d="M0 0 url(x)"></path></svg>`);
  const rect = r.tree.children[0].children[0];
  assert.deepEqual(rect.attrs, [["width", "10.5"]]);
  const circle = r.tree.children[0].children[1];
  assert.deepEqual(circle.attrs, [["cx", "1"], ["cy", "2"]]);
  assert.deepEqual(r.tree.children[0].children[2].attrs, [["d", "M 0 0 L 10 10 Z"]]);
  assert.deepEqual(r.tree.children[0].children[3].attrs, []);
});

test("[R-ATTR-ALLOWLIST, R-VAL-KEYWORD] SVG camelCase attributes keep canonical case; data-hover is boolean", () => {
  const r = ok(`<svg viewbox="0 0 10 5" VIEWBOX="1 1 1 1" preserveaspectratio="none"><g data-hover="yes" data-action="h"></g><text textlength="10">t</text></svg>`);
  assert.deepEqual(r.tree.children[0].attrs, [["preserveAspectRatio", "none"], ["viewBox", "0 0 10 5"]]);
  assert.deepEqual(r.tree.children[0].children[0].attrs, [["data-action", "h"], ["data-hover", ""]]);
  assert.deepEqual(r.tree.children[0].children[1].attrs, [["textLength", "10"]]);
  assert.ok(isValidated(r.tree));
});

test("[R-VAL-COLOR] paint values: only solid colors", () => {
  const r = ok(`<svg><rect fill="#FF0000" stroke="rgb(1, 2, 3)" width="1" height="1"></rect><rect fill="url(#g)" stroke="expression(1)" width="1" height="1"></rect><rect fill="red;background:url(x)" width="1" height="1"></rect></svg>`);
  const [a, b, c] = r.tree.children[0].children;
  assert.deepEqual(a.attrs, [["fill", "#FF0000"], ["height", "1"], ["stroke", "rgb(1, 2, 3)"], ["width", "1"]]);
  assert.deepEqual(b.attrs, [["height", "1"], ["width", "1"]]);
  assert.deepEqual(c.attrs, [["height", "1"], ["width", "1"]]);
});

test("[R-STYLE-CLASS] classes are restricted to the bundled allowlist", () => {
  const r = ok(`<div class="card evil muted"></div><div class="evil"></div>`);
  assert.deepEqual(r.tree.children[0].attrs, [["class", "card muted"]]);
  assert.deepEqual(r.tree.children[1].attrs, []);
});

test("[R-CLOBBER-ID-PREFIX] ids are prefixed and idrefs rewritten; bad ids dropped", () => {
  const r = ok(`<label for="name">N</label><input id="name"><div id="__proto__"></div><div id="a b"></div><table><tr><th headers="x y">h</th></tr></table>`);
  assert.deepEqual(r.tree.children[0].attrs, [["for", "g-name"]]);
  assert.deepEqual(r.tree.children[1].attrs, [["autocomplete", "off"], ["id", "g-name"], ["type", "text"]]);
  assert.deepEqual(r.tree.children[2].attrs, []); // ids must start with a letter
  assert.deepEqual(r.tree.children[3].attrs, []);
  const th = r.tree.children[4].children[0].children[0].children[0]; // table > tbody > tr > th
  assert.deepEqual(th.attrs, [["headers", "g-x g-y"]]);
});

test("[R-CLOBBER-ATTR-KEYS] attribute names never become object keys", () => {
  const r = ok(`<div __proto__="x" constructor="y" prototype="z"></div>`);
  assert.deepEqual(r.tree.children[0].attrs, []);
  assert.equal(Object.getPrototypeOf(r.tree.children[0]), Object.prototype);
});

test("[R-CTRL-INPUT-TYPE, R-CTRL-AUTOCOMPLETE, R-CTRL-FOCUS] form controls: unsafe types dropped, autocomplete forced off, focus stealing attrs removed", () => {
  const r = ok(`<input type="password" autocomplete="current-password"><input type="hidden" value="x"><input type="file"><input type="submit">
    <input type="text" autofocus accesskey="k" tabindex="5" contenteditable autocomplete="cc-number">
    <textarea autocomplete="on">t</textarea><select autocomplete="on"><option selected>a</option></select>`);
  const inputs = r.tree.children.filter((c) => c.kind === "el");
  // password/hidden/file/submit all lose their type; policy defaults them to text
  // with autocomplete off, so a password field cannot trigger credential autofill.
  for (const i of inputs.filter((c) => c.tag === "input")) {
    const names = i.attrs.map((a) => a[0]);
    assert.deepEqual(i.attrs.filter((a) => a[0] !== "value"), [["autocomplete", "off"], ["type", "text"]]);
    for (const bad of ["autofocus", "accesskey", "tabindex", "contenteditable", "name"]) assert.ok(!names.includes(bad), bad);
  }
  assert.deepEqual(inputs.find((c) => c.tag === "textarea").attrs, [["autocomplete", "off"]]);
  assert.deepEqual(inputs.find((c) => c.tag === "select").attrs, [["autocomplete", "off"]]);
});

test("[R-TEXT-CONTROL-BIDI] control and bidi characters are stripped from text and attributes", () => {
  const r = ok(`<p title="a‮b">x y‮z⁦w</p>`);
  assert.deepEqual(r.tree.children[0].attrs, [["title", "ab"]]);
  assert.equal(r.tree.children[0].children[0].text, "xyzw");
});

test("[R-LIMIT-TREE] structural limits reject rather than truncate", () => {
  const deep = "<div>".repeat(LIMITS.maxDepth + 2) + "x" + "</div>".repeat(LIMITS.maxDepth + 2);
  assert.equal(check(deep).status, "rejected");
  // The policy's node limit, exercised on a raw tree built directly. It cannot
  // be reached through the parser: the frontend's maxRawNodes equals the
  // policy's maxNodes and a raw tree never has fewer nodes than its output, so
  // preprocessing refuses a document this large first (covered in
  // test/preprocess.test.js). Building the raw tree here keeps the POLICY
  // limit itself under test.
  const wideResult = checkTree({ kind: "root", children: Array.from({ length: LIMITS.maxNodes + 1 }, () => ({ kind: "el", ns: "html", tag: "p", attrs: [], children: [] })) });
  assert.equal(wideResult.status, "rejected");
  assert.deepEqual(wideResult.reasons.map((r) => r.code ?? r), ["too-many-nodes"]);
  const longText = "<p>" + "a".repeat(LIMITS.maxTextLength + 1) + "</p>";
  assert.equal(check(longText).status, "rejected");
});

test("[R-STRUCT-NON-ELEMENT] comments and doctype are dropped", () => {
  const r = ok(`<!doctype html><!-- c --><p>a<!-- d -->b</p>`);
  assert.deepEqual(collect(r.tree).tags, ["html:p"]);
});

test("[R-FRAME-FIXED-POINT] validated output is a fixed point of the policy", () => {
  const html = `<div class="card"><h1 id="t">T</h1><svg viewBox="0 0 10 10"><path d="M0 0L5 5" fill="red"></path><text x="1" y="2">t</text></svg><button data-action="go" data-value="1">go</button></div>`;
  const r = ok(html);
  assert.ok(isValidated(r.tree));
  assert.ok(isTreeShaped(r.tree));
  assert.ok(r.changes.length > 0); // id rewrite and forced button type
});

test("[R-FRAME-FIXED-POINT] forged trees are not validated", () => {
  assert.equal(isValidated({ kind: "root", children: [{ kind: "el", ns: "html", tag: "script", attrs: [], children: [] }] }), false);
  assert.equal(isValidated({ kind: "root", children: [{ kind: "el", ns: "svg", tag: "script", attrs: [], children: [] }] }), false);
  assert.equal(isValidated({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["onclick", "x"]], children: [] }] }), false);
  assert.equal(isValidated({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["class", "card"]], children: [] }] }), true);
  // Unsorted attributes are not canonical, so not a fixed point.
  assert.equal(isValidated({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: [["title", "a"], ["class", "card"]], children: [] }] }), false);
  assert.equal(isTreeShaped({ kind: "root", children: [{ kind: "el", ns: "html", tag: "div", attrs: { onclick: "x" }, children: [] }] }), false);
});

test("[R-RCDATA-NO-REPARSE] browser DOM adapter and parse5 adapter agree on a corpus", () => {
  const corpus = [
    `<div class="card"><p>hi</p><svg><rect width="1" height="1"/><desc><b>x</b></desc></svg></div>`,
    `<table><tr><td>a<td>b</table><math><mi>x</mi></math>`,
    `<p><a href="x">t</a><b>u</p></b><i>v`,
    `<svg><foreignObject><p>x</p></foreignObject><title>t</title></svg>`,
    `<select><option>a<option>b</select><textarea><b>x</b></textarea>`,
    `<noscript><img src=x></noscript><template><p>t</p></template>`,
  ];
  for (const html of corpus) {
    const a = checkTree(p5(html));
    const b = checkTree(domParse(html, window.DOMParser));
    assert.deepEqual(a.tree, b.tree, html);
  }
});

test("[R-EXEC-SCRIPT, R-EXEC-HANDLER, R-RES-URL-ATTR] owasp-style evasions produce no executable surface", () => {
  const cases = [
    `<IMG SRC=JaVaScRiPt:alert('XSS')>`,
    `<IMG """><SCRIPT>alert("XSS")</SCRIPT>"\>`,
    `<a onmouseover="alert(document.cookie)">xxs link</a>`,
    `<IMG SRC=# onmouseover="alert('xxs')">`,
    `<<SCRIPT>alert("XSS");//\<</SCRIPT>`,
    `<SCRIPT SRC=//ha.ckers.org/.j>`,
    `<BODY ONLOAD=alert('XSS')>`,
    `<STYLE>li {list-style-image: url("javascript:alert('XSS')");}</STYLE><UL><LI>XSS</br>`,
    `<svg/onload=alert(1)>`,
    `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`,
    `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
    `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
    `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
    `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
    `<div id="x" title="</div><script>alert(1)</script>">`,
    `<p><iframe srcdoc="<script>alert(1)</script>"></iframe>`,
    `<details open ontoggle=alert(1)>`,
    `<input onfocus=alert(1) autofocus>`,
    `<object data="data:text/html,<script>alert(1)</script>">`,
    `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
    `<base href="javascript:alert(1)//">`,
    `<svg><set attributeName="onload" to="alert(1)"/>`,
    `<svg><a xlink:href="javascript:alert(1)"><text x=20 y=20>XSS</text></a>`,
  ];
  for (const html of cases) {
    const r = check(html);
    if (r.status !== "validated") continue; // rejection is acceptable
    const { tags, attrs } = collect(r.tree);
    for (const t of tags) assert.ok(!/script|style|iframe|object|img|meta|base|animate|set|^svg:a$|mglyph|math|noscript/.test(t), `${html} -> ${t}`);
    for (const a of attrs) assert.ok(!/^on|src|href|data$|style|action/.test(a), `${html} -> ${a}`);
    assert.ok(!serialize(r.tree).toLowerCase().includes("javascript:"), html);
  }
});

// ---------------------------------------------------------------------------
// R5: the capability kernel. These tests read rules/policy.json and
// rules/capabilities.json only. They never touch the red-team corpus, the
// parser or an engine, so an invalid configuration fails here whether or not a
// matching exploit exists anywhere in the test inputs.

const shippedProfile = () => JSON.parse(readFileSync(new URL("../rules/policy.json", import.meta.url), "utf8"));
const caps = loadCapabilities();
const validate = (mutate) => {
  const profile = shippedProfile();
  mutate(profile);
  return validatePolicy(profile, caps);
};
const rejects = (mutate, fragment) =>
  assert.throws(() => validate(mutate), (e) => {
    assert.ok(e.message.includes(fragment), `${e.message} does not mention ${fragment}`);
    return true;
  });

test("[R-CAP-INVENTORY] the shipped profile restricts the reviewed capability kernel", () => {
  assert.equal(validate(() => {}), undefined);
  assert.equal(CAPABILITY_VERSION, CAPABILITIES.capabilityVersion);
  // The generated JS inventory and the reviewed source agree.
  assert.deepEqual(CAPABILITIES, caps);
  // The inventory's meaning is versioned and reviewed, not just its contents.
  assert.ok(CAPABILITIES.meaning.length > 200);
  assert.match(CAPABILITIES.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  for (const rule of CAPABILITY_RULES) assert.ok(RULE_IDS.includes(rule), rule);
});

test("[R-CAP-INVENTORY] unsafe elements cannot be added to a profile", () => {
  rejects((p) => { p.htmlElements.iframe = null; }, "html element iframe is excluded by the capability kernel");
  rejects((p) => { p.htmlElements.object = null; }, "html element object is excluded by the capability kernel");
  rejects((p) => { p.svgElements.use = null; }, "svg element use is excluded by the capability kernel");
  rejects((p) => { p.svgElements.foreignobject = null; }, "svg element foreignobject is excluded by the capability kernel");
  // An element that is neither permitted nor explicitly excluded is still
  // outside the closed inventory.
  rejects((p) => { p.htmlElements.marquee = null; }, "html element marquee is excluded by the capability kernel");
  rejects((p) => { p.htmlElements.dialog = null; }, "html element dialog is excluded by the capability kernel");
  rejects((p) => { p.svgElements.tref = null; }, "svg element tref is not in the capability inventory");
});

test("[R-CAP-INVENTORY] URL-valued attributes cannot be introduced with a text grammar", () => {
  rejects((p) => { p.htmlElements.div = { href: ["text"] }; }, "html div attribute href is excluded");
  rejects((p) => { p.htmlElements.div = { src: ["text"] }; }, "html div attribute src is excluded");
  rejects((p) => { p.sharedGlobal.action = ["text"]; }, "shared global attribute action is excluded");
  rejects((p) => { p.svgGlobal["xlink:href"] = ["text"]; }, "invalid allowed attribute xlink:href");
  rejects((p) => { p.htmlGlobal.style = ["text"]; }, "html global attribute style is excluded");
  rejects((p) => { p.sharedGlobal.name = ["ident"]; }, "shared global attribute name is excluded");
});

test("[R-CAP-INVENTORY] SVG paint keeps restricted solid-paint validation", () => {
  for (const paint of ["fill", "stroke"]) {
    rejects((p) => { p.svgGlobal[paint] = ["text"]; }, `svg global attribute ${paint}: ["text"] does not restrict the kernel grammar ["color"]`);
    rejects((p) => { p.svgGlobal[paint] = ["ident"]; }, `does not restrict the kernel grammar ["color"]`);
    rejects((p) => { p.svgElements.rect[paint] = ["text"]; }, `svg rect attribute ${paint}: ["text"] does not restrict the kernel grammar ["color"]`);
  }
  // `title` may use plain text: identical grammars are a valid restriction.
  assert.equal(validate((p) => { p.htmlGlobal.title = ["text"]; }), undefined);
});

test("[R-CAP-INVENTORY] value grammars can only be narrowed, never traded", () => {
  rejects((p) => { p.svgGlobal["stroke-width"] = ["num"]; }, 'does not restrict the kernel grammar ["nonNeg"]');
  rejects((p) => { p.svgElements.path.d = ["text"]; }, 'does not restrict the kernel grammar ["path"]');
  rejects((p) => { p.sharedGlobal.id = ["text"]; }, 'does not restrict the kernel grammar ["id"]');
  rejects((p) => { p.sharedGlobal.class = ["text"]; }, 'does not restrict the kernel grammar ["cls"]');
  rejects((p) => { p.htmlGlobal.dir = ["oneOf", ["ltr", "rtl", "auto", "anything"]]; }, "does not restrict the kernel grammar");
  rejects((p) => { p.sharedGlobal["aria-level"] = ["int", 1, 99]; }, "does not restrict the kernel grammar");
  rejects((p) => { p.sharedGlobal["aria-level"] = ["int", 0, 6]; }, "does not restrict the kernel grammar");
  rejects((p) => { p.svgGlobal["stroke-dasharray"] = ["numList", 4096]; }, "does not restrict the kernel grammar");
  rejects((p) => { p.htmlElements.button.type = ["tagged", "R-CTRL-BUTTON-TYPE", ["fixed", "submit"]]; }, "does not restrict the kernel grammar");
  rejects((p) => { p.sharedGlobal["data-secret"] = ["text"]; }, "shared global attribute data-secret is not in the capability inventory");
  rejects((p) => { p.htmlUnwrap.push(["script", "R-EXEC-SCRIPT"]); }, "html script is not a reviewed unwrappable element");
});

test("[R-CAP-CEILINGS] hard limits cannot be raised above the kernel ceilings", () => {
  for (const [key, ceiling] of Object.entries(caps.ceilings)) {
    rejects((p) => { p.limits[key] = ceiling + 1; }, `limit ${key}=${ceiling + 1} exceeds the kernel ceiling ${ceiling}`);
  }
  // Lowering every limit is a restriction.
  assert.equal(validate((p) => { for (const key of Object.keys(p.limits)) p.limits[key] = 1; }), undefined);
});

test("[R-CAP-CONTROLS] mandatory controls and text-only contexts cannot be weakened", () => {
  rejects((p) => { delete p.htmlForced.button; }, "html button must force type");
  rejects((p) => { p.htmlForced.button = [["type", "submit"]]; }, "html button must force type");
  for (const tag of ["input", "select", "textarea"]) {
    rejects((p) => { delete p.htmlForced[tag]; }, `html ${tag} must force autocomplete`);
  }
  rejects((p) => { delete p.htmlElements.input.type; }, "html input must keep the mandatory attribute type");
  rejects((p) => { p.svgTextOnly = []; }, "svg title must remain a text-only context");
  rejects((p) => { p.svgTextOnly = ["title"]; }, "svg desc must remain a text-only context");
  // Dropping the element entirely is a restriction, not a weakening.
  assert.equal(validate((p) => { delete p.htmlElements.button; delete p.htmlForced.button; }), undefined);
});

test("[R-CAP-INVENTORY, R-CAP-CEILINGS, R-CAP-CONTROLS] valid restrictions are accepted and benign capability is preserved", () => {
  const restricted = shippedProfile();
  restricted.htmlElements.input.type = ["tagged", "R-CTRL-INPUT-TYPE", ["oneOf", ["text"]]];
  restricted.sharedGlobal["aria-level"] = ["int", 2, 3];
  restricted.svgGlobal["stroke-dasharray"] = ["numList", 4];
  restricted.svgTextOnly = ["title", "desc", "text"];
  restricted.limits.maxNodes = 100;
  delete restricted.htmlElements.meter;
  validatePolicy(restricted, caps);
  // The shipped profile itself still permits the benign constructs it always
  // did; capability validation did not silently narrow the policy.
  const benign = ok(`<div class="card" id="t"><h1>T</h1><svg viewBox="0 0 10 10"><path d="M0 0L5 5" fill="red"></path><text x="1" y="2">t</text></svg><button data-action="go">go</button></div>`);
  const { tags, attrs } = collect(benign.tree);
  assert.deepEqual(tags, ["html:div", "html:h1", "svg:svg", "svg:path", "svg:text", "html:button"]);
  for (const expected of ["class", "id", "viewBox", "d", "fill", "x", "y", "data-action", "type"]) {
    assert.ok(attrs.includes(expected), `benign attribute ${expected} was lost`);
  }
});

test("[R-LIMIT-TREE] a deep chain of unwrapped elements is bounded, not a stack overflow", () => {
  // Unwrapped elements do not increase output depth, so LIMITS.maxDepth cannot
  // bound this. Only reachable by calling checkTree() with a hand-built raw
  // tree: the HTML path bounds raw depth long before this.
  const chain = (n) => {
    let node = { kind: "text", text: "deep" };
    for (let i = 0; i < n; i++) node = { kind: "el", ns: "html", tag: "q", attrs: [], children: [node] };
    return { kind: "root", children: [node] };
  };
  const inside = checkTree(chain(LIMITS.maxTraversalDepth - 1));
  assert.equal(inside.status, "validated");
  assert.equal(inside.tree.children[0].text, "deep");
  const beyond = checkTree(chain(LIMITS.maxTraversalDepth + 1));
  assert.equal(beyond.status, "rejected");
  assert.deepEqual(beyond.reasons.map((r) => r.code), ["traversal-depth"]);
  // The shape that used to overflow the stack: 100,000 nested unwrapped
  // elements now produce a bounded structured rejection.
  const huge = checkTree(chain(100000));
  assert.equal(huge.status, "rejected");
  assert.deepEqual(huge.reasons.map((r) => r.code), ["traversal-depth"]);
  // The same shape built from allowed elements is rejected by the depth limit
  // rather than by the traversal ceiling.
  let deep = { kind: "text", text: "x" };
  for (let i = 0; i < LIMITS.maxDepth + 5; i++) deep = { kind: "el", ns: "html", tag: "div", attrs: [], children: [deep] };
  assert.deepEqual(checkTree({ kind: "root", children: [deep] }).reasons.map((r) => r.code), ["too-deep"]);
});
