import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAdvisory, buildIssueBody } from "../scripts/security-scout.mjs";

const advisory = (overrides = {}) => ({
  ghsa_id: "GHSA-abcd-1234-efgh",
  cve_id: "CVE-2026-12345",
  html_url: "https://github.com/advisories/GHSA-abcd-1234-efgh",
  summary: "HTML sanitizer mutation XSS",
  description: "A namespace transition bypasses filtering.",
  severity: "high",
  cwe_ids: ["CWE-79"],
  vulnerabilities: [{ package: { ecosystem: "npm", name: "example-html-sanitizer" } }],
  ...overrides,
});

test("security scout ranks sanitizer and XSS advisories but ignores unrelated reports", () => {
  assert.ok(rankAdvisory(advisory()) >= 2);
  assert.equal(rankAdvisory(advisory({
    summary: "Incorrect calculation in a cryptographic protocol",
    description: "Signature verification can fail.",
    cwe_ids: ["CWE-682"],
    vulnerabilities: [{ package: { ecosystem: "npm", name: "crypto-example" } }],
  })), 0);
});

test("security scout report bounds and escapes untrusted advisory summaries", () => {
  const body = buildIssueBody([
    advisory({ summary: "<script>@maintainer | investigate</script>", html_url: "https://attacker.invalid/advisory" }),
  ], { since: "2026-08-12", until: "2026-09-11" });
  assert.ok(body.includes("https://github.com/advisories/GHSA-abcd-1234-efgh"));
  assert.ok(body.includes("&lt;script>"));
  assert.ok(body.includes("\\|"));
  assert.ok(!body.includes("@maintainer"));
  assert.ok(body.includes("Triage checklist"));
});
