import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const coreUrl = new URL("../cdn/generative-web-guard.js", import.meta.url);
const fullUrl = new URL("../cdn/generative-web-guard.full.min.js", import.meta.url);
const core = await import(`${coreUrl.href}?check=${Date.now()}`);
const full = await import(`${fullUrl.href}?check=${Date.now()}`);

for (const name of ["guardHtml", "createGuardFrame", "gateProgram", "checkTree", "manifest"]) {
  assert.ok(name in core, `CDN core export missing: ${name}`);
}
for (const name of ["createGuardWorker", "createGuardRuntime"]) {
  assert.ok(name in full, `CDN full export missing: ${name}`);
}

const result = core.guardHtml("<p onclick=bad()>safe<script>alert(1)</script></p>");
assert.equal(result.status, "validated");
assert.equal(result.changes.length, 2);
assert.ok(!JSON.stringify(result.tree).includes("script"));
assert.ok(!JSON.stringify(result.tree).includes("onclick"));

for (const file of ["generative-web-guard.js", "generative-web-guard.min.js", "generative-web-guard.full.min.js", "worker.min.js"]) {
  const contents = await readFile(new URL(`../cdn/${file}`, import.meta.url), "utf8");
  assert.ok(contents.length > 100, `CDN artifact is unexpectedly empty: ${file}`);
}

console.log("CDN artifacts: imports, public exports, and malicious-markup smoke check passed");
