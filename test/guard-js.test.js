import { test } from "node:test";
import assert from "node:assert/strict";
import { runInitialView } from "../scripts/guard-js.mjs";
import { createHtmlGuard, filterHtml } from "../scripts/guard-html.mjs";

test("[R-RT-ISOLATION, R-CHECK-ACCEPTANCE] guard:js runs a data-aware initial view then filters it", async () => {
  const view = await runInitialView(`
    const initialState = {};
    function update(state) { return state; }
    function view() { return '<p>' + data.name + '</p><script>bad()</script><p onclick="bad()">kept</p>'; }
  `, JSON.stringify({ name: "Ada" }));
  const guard = await createHtmlGuard();
  try {
    const result = filterHtml(guard, view);
    assert.equal(result.status, "accepted");
    assert.equal(result.html, "<p>Ada</p><p>kept</p>");
  } finally {
    guard.checker.dispose();
  }
});
