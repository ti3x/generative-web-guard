// Weekly, deterministic security-advisory scout. Advisory text is untrusted:
// the report uses only bounded, escaped summaries and links supplied by GitHub.
import { pathToFileURL } from "node:url";

const HTML_SVG_RE = /html sanit|sanitizer|mutation xss|\bmxss\b|dom clobber|mathml|svg|srcdoc|html parser|parser differential|trusted types|content security policy/i;
const JS_RUNTIME_RE = /quickjs|javascript sandbox|ecmascript sandbox|javascript parser|ast parser|dom[- ]based xss/i;
const XSS_RE = /cross[- ]site scripting|\bxss\b|script injection/i;
const DOS_RE = /denial of service|\bdos\b|resource exhaustion|stack overflow|deep(?:ly)? nested/i;
const PACKAGE_RE = /dompurify|sanitize-html|html-sanitizer|rails-html-sanitizer|loofah|bleach|js-xss|htmlparser|parse5|rehype-sanitize|hast-util-sanitize|quickjs|quickjs-emscripten|acorn|esbuild/i;
const RELEVANT_CWES = new Set(["CWE-20", "CWE-79", "CWE-80", "CWE-83", "CWE-84", "CWE-87", "CWE-91", "CWE-94", "CWE-95", "CWE-116", "CWE-184", "CWE-185", "CWE-400", "CWE-1321"]);

function advisoryText(advisory) {
  const packages = (advisory.vulnerabilities ?? []).map((v) => v.package?.name ?? "").join(" ");
  return `${advisory.summary ?? ""} ${advisory.description ?? ""} ${packages}`;
}

export function rankAdvisory(advisory) {
  const text = advisoryText(advisory);
  const packages = (advisory.vulnerabilities ?? []).map((v) => v.package?.name ?? "").join(" ");
  const cwes = new Set(advisory.cwe_ids ?? advisory.cwes?.map((c) => c.cwe_id) ?? []);
  // CWE-20/CWE-400 and words such as "resource" occur in a vast range of
  // unrelated software. They can refine a candidate already connected to this
  // guard's HTML/SVG or JavaScript boundary; they never create one by
  // themselves.
  const directHtmlSvg = HTML_SVG_RE.test(text);
  const directJsRuntime = JS_RUNTIME_RE.test(text);
  const relevantPackage = PACKAGE_RE.test(packages);
  if (!directHtmlSvg && !directJsRuntime && !relevantPackage) return 0;
  let score = 0;
  if (directHtmlSvg) score += 5;
  if (directJsRuntime) score += 5;
  if (relevantPackage) score += 5;
  if (XSS_RE.test(text)) score += 2;
  if (DOS_RE.test(text)) score += 2;
  if ([...cwes].some((cwe) => RELEVANT_CWES.has(cwe))) score += 1;
  return score;
}

function cleanCell(value, max = 180) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/@/g, "@\u200b")
    .replace(/\|/g, "\\|")
    .slice(0, max);
}

function identifier(advisory) {
  return advisory.cve_id || advisory.ghsa_id || "unassigned";
}

export function buildIssueBody(advisories, { since, until }) {
  const rows = advisories.map((a) => {
    const packages = (a.vulnerabilities ?? []).map((v) => `${v.package?.ecosystem ?? "?"}/${v.package?.name ?? "?"}`).slice(0, 4).join(", ");
    const link = /^https:\/\/github\.com\//.test(a.html_url ?? "") ? a.html_url : `https://github.com/advisories/${a.ghsa_id}`;
    return `| [${cleanCell(identifier(a), 40)}](${link}) | ${cleanCell(a.severity, 16)} | ${rankAdvisory(a)} | ${cleanCell(packages)} | ${cleanCell(a.summary)} |`;
  });
  return [
    `Security-advisory candidates published from **${since}** through **${until}**.`,
    "",
    "> Advisory content is untrusted external input. This report is deterministic and does not execute payloads or modify policy.",
    "",
    "| Advisory | Severity | Relevance | Packages | Summary |",
    "|---|---:|---:|---|---|",
    ...rows,
    "",
    "### Triage checklist",
    "",
    "- [ ] Confirm the advisory and upstream references describe the claimed behavior.",
    "- [ ] Decide whether it affects parsing, tree policy, rendering, the JS gate, QuickJS, or browser isolation.",
    "- [ ] Reconstruct the smallest non-executing payload in `red-team/corpus.json`.",
    "- [ ] Add an explicit expected outcome and a benign preservation case.",
    "- [ ] Add `@cve:` and `@rule:` regression coverage when applicable.",
    "- [ ] Review whether a Lean theorem changes or whether the issue is outside its model.",
    "- [ ] Run `npm test` and `npm run check:browser` before closing.",
    "",
    `Automated scout window: ${since}/${until}.`,
  ].join("\n");
}

function nextLink(headers) {
  const link = headers.get("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

async function github(url, { token, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "generative-web-guard-security-scout",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${url}: ${response.status} ${await response.text()}`);
  return response;
}

async function collectAdvisories(apiBase, token, since) {
  let url = `${apiBase}/advisories?type=reviewed&published=%3E%3D${since}&sort=published&direction=desc&per_page=100`;
  const out = [];
  for (let page = 0; url && page < 5; page++) {
    const response = await github(url, { token });
    out.push(...await response.json());
    url = nextLink(response.headers);
  }
  return out;
}

async function reportedIds(apiBase, token, repository) {
  const response = await github(`${apiBase}/repos/${repository}/issues?state=all&labels=security-scout&per_page=100`, { token });
  const issues = await response.json();
  return new Set(issues.flatMap((issue) => String(issue.body ?? "").match(/(?:GHSA-[\w-]+|CVE-\d{4}-\d{4,})/g) ?? []));
}

export async function main(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("security scout requires GITHUB_TOKEN and GITHUB_REPOSITORY");
  const days = Math.max(1, Math.min(90, Number(env.LOOKBACK_DAYS || 30)));
  const now = env.SCOUT_NOW ? new Date(env.SCOUT_NOW) : new Date();
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const apiBase = env.GITHUB_API_URL || "https://api.github.com";
  const advisories = await collectAdvisories(apiBase, token, since);
  const already = await reportedIds(apiBase, token, repository);
  const candidates = advisories
    .filter((a) => rankAdvisory(a) >= 2)
    .filter((a) => !already.has(a.ghsa_id) && !already.has(a.cve_id))
    .sort((a, b) => rankAdvisory(b) - rankAdvisory(a) || String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, 25);
  if (!candidates.length) {
    console.log(`security scout: no new relevant advisories since ${since}`);
    return null;
  }
  const title = `Weekly HTML, JS, and SVG security scout — ${until}`;
  const body = buildIssueBody(candidates, { since, until });
  if (env.SCOUT_DRY_RUN === "1") {
    console.log(`${title}\n\n${body}`);
    return { title, body, candidates };
  }
  const labelResponse = await fetch(`${apiBase}/repos/${repository}/labels`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "generative-web-guard-security-scout" },
    body: JSON.stringify({ name: "security-scout", color: "b60205", description: "Automated candidates for security regression review" }),
  });
  if (!labelResponse.ok && labelResponse.status !== 422) throw new Error(`could not create security-scout label: ${labelResponse.status}`);
  const response = await github(`${apiBase}/repos/${repository}/issues`, {
    token,
    method: "POST",
    body: { title, body, labels: ["security-scout"] },
  });
  const issue = await response.json();
  console.log(`security scout: created ${issue.html_url}`);
  return issue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
