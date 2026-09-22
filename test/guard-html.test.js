import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHtmlGuard, filterHtml, serializeAcceptedTree } from "../scripts/guard-html.mjs";

let guard;
before(async () => { guard = await createHtmlGuard(); });
after(() => { guard.checker.dispose(); });

test("[R-CHECK-ACCEPTANCE] guard:html emits only the exact Lean-accepted markup", () => {
  const result = filterHtml(guard, '<h1>Hello &amp; welcome</h1><script>alert(1)</script><p onclick="x()">safe</p>');
  assert.equal(result.status, "accepted");
  assert.equal(result.html, "<h1>Hello &amp; welcome</h1><p>safe</p>");
  assert.doesNotMatch(result.html, /script|onclick/i);
});

test("[R-RENDER-CONSTRUCTORS-ONLY] guard:html serializer escapes accepted text and attributes", () => {
  assert.equal(serializeAcceptedTree({ kind: "root", children: [{
    kind: "el", ns: "html", tag: "p", attrs: [["title", 'a"<&']], children: [{ kind: "text", text: "<&>" }],
  }] }), '<p title="a&quot;&lt;&amp;">&lt;&amp;&gt;</p>');
});
