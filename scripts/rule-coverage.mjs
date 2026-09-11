// Rule coverage gate. Joins rules/catalog.json with the Cucumber features,
// the generated id files, unit-test title prefixes and code usages, prints a
// matrix, and exits non-zero on any gap:
//   - a catalog rule with no scenario
//   - a scenario with no @rule: tag
//   - a @rule: or @cve: tag naming something not in the catalog
//   - a catalog CVE reference with no scenario
//   - a generated id file containing an id absent from the catalog
//   - a RULES.X / R.X usage in code with no catalog entry
//   - a two-engine rule cited in only one language (unless the rule declares no cites)
//   - a cited file that does not exist
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, AstBuilder, GherkinClassicTokenMatcher } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import { loadCatalog, constName } from "./gen-rules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => relative(root, p);

function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== ".lake") walk(p, ext, out); }
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

// --- features -----------------------------------------------------------------
function parseFeatures() {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
  const scenarios = [];
  for (const file of walk(resolve(root, "features"), ".feature")) {
    const doc = parser.parse(readFileSync(file, "utf8"));
    const featureTags = (doc.feature?.tags ?? []).map((t) => t.name);
    for (const child of doc.feature?.children ?? []) {
      const items = child.rule ? child.rule.children : [child];
      for (const it of items) {
        if (!it.scenario) continue;
        const tags = [...featureTags, ...it.scenario.tags.map((t) => t.name), ...it.scenario.examples.flatMap((e) => e.tags.map((t) => t.name))];
        scenarios.push({
          file: rel(file), name: it.scenario.name, line: it.scenario.location.line,
          rules: tags.filter((t) => t.startsWith("@rule:")).map((t) => t.slice(6)),
          cves: tags.filter((t) => t.startsWith("@cve:")).map((t) => t.slice(5)),
        });
      }
    }
  }
  return scenarios;
}

// --- unit tests: `[R-A, R-B] title` --------------------------------------------
function unitTitles() {
  const hits = new Map();
  for (const file of walk(resolve(root, "test"), ".test.js")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/test\(\s*["'`]\[([^\]]+)\]/g)) {
      for (const id of m[1].split(",").map((s) => s.trim())) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
  }
  return hits;
}

// --- code usages ----------------------------------------------------------------
function codeUsages() {
  const js = new Set(), lean = new Set();
  for (const file of walk(resolve(root, "src"), ".js")) {
    if (file.endsWith("rules.js")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/RULES\.([A-Z0-9_]+)/g)) js.add(m[1]);
    if (file.endsWith("policy-data.js")) {
      for (const m of readFileSync(file, "utf8").matchAll(/"(R-[A-Z0-9-]+)"/g)) js.add(constName(m[1]));
    }
  }
  for (const file of walk(resolve(root, "lean/Guard"), ".lean")) {
    if (file.endsWith("Rules.lean")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/\bR\.([A-Z][A-Z0-9_]+)/g)) lean.add(m[1]);
  }
  return { js, lean };
}

function generatedIds() {
  const ids = new Set();
  for (const f of ["src/rules.js", "lean/Guard/Rules.lean"]) {
    const p = resolve(root, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/"(R-[A-Z0-9-]+)"/g)) ids.add(m[1]);
  }
  return ids;
}

// --- report ---------------------------------------------------------------------
const catalog = loadCatalog();
const rules = new Map(catalog.rules.map((r) => [r.id, r]));
const scenarios = parseFeatures();
const units = unitTitles();
const usage = codeUsages();
const errors = [];

const byRule = new Map(catalog.rules.map((r) => [r.id, []]));
const cveScenarios = new Map();
for (const s of scenarios) {
  if (s.rules.length === 0) errors.push(`${s.file}:${s.line} "${s.name}" has no @rule: tag`);
  for (const id of s.rules) {
    if (!rules.has(id)) errors.push(`${s.file}:${s.line} unknown rule tag ${id}`);
    else byRule.get(id).push(s);
  }
  for (const cve of s.cves) cveScenarios.set(cve, (cveScenarios.get(cve) ?? 0) + 1);
}

const catalogCves = new Set();
for (const r of catalog.rules) for (const ref of r.references) if (ref.type === "cve") catalogCves.add(ref.id);
for (const cve of cveScenarios.keys()) if (!catalogCves.has(cve)) errors.push(`@cve:${cve} is tagged in a scenario but referenced by no rule`);
for (const cve of catalogCves) if (!cveScenarios.has(cve)) errors.push(`${cve} is referenced in the catalog but has no scenario`);

for (const id of generatedIds()) if (!rules.has(id)) errors.push(`generated files contain ${id}, not in catalog (run npm run gen:rules)`);
for (const c of usage.js) if (!rules.has(`R-${c.replace(/_/g, "-")}`)) errors.push(`src uses RULES.${c} which is not in the catalog`);
for (const c of usage.lean) if (!rules.has(`R-${c.replace(/_/g, "-")}`) && c !== "all" && c !== "isRule") errors.push(`lean uses R.${c} which is not in the catalog`);

const rows = [];
for (const r of catalog.rules) {
  const c = constName(r.id);
  const inJs = usage.js.has(c), inLean = usage.lean.has(c);
  const n = byRule.get(r.id).length;
  if (n === 0) errors.push(`${r.id} has no scenario`);
  if (r.engines.includes("lean") && r.cites.length > 0 && inJs !== inLean) {
    errors.push(`${r.id} is cited in ${inJs ? "JavaScript" : "Lean"} code only`);
  }
  for (const cite of r.cites) {
    const file = cite.split("#")[0];
    if (!existsSync(resolve(root, file))) errors.push(`${r.id} cites missing file ${file}`);
  }
  rows.push({
    id: r.id, class: r.class, engines: r.engines.join("+"), scenarios: n, unit: units.get(r.id) ?? 0,
    js: inJs ? "yes" : (r.engines.includes("lean") ? "-" : "n/a"), lean: inLean ? "yes" : (r.engines.includes("lean") ? "-" : "n/a"),
    proofs: r.proofs.length, cves: r.references.filter((x) => x.type === "cve").length,
  });
}

const w = (s, n) => String(s).padEnd(n);
console.log(`${w("rule", 30)}${w("class", 14)}${w("engines", 9)}${w("scen", 6)}${w("unit", 6)}${w("js", 5)}${w("lean", 6)}${w("proofs", 8)}cves`);
for (const r of rows) {
  console.log(`${w(r.id, 30)}${w(r.class, 14)}${w(r.engines, 9)}${w(r.scenarios, 6)}${w(r.unit, 6)}${w(r.js, 5)}${w(r.lean, 6)}${w(r.proofs, 8)}${r.cves}`);
}
console.log(`\n${catalog.rules.length} rules, ${scenarios.length} scenarios, ${catalogCves.size} CVE references`);

if (errors.length) {
  console.error(`\n${errors.length} coverage error(s):\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log("rule traceability: complete (not a proof of security; npm test separately audits theorems and behavior)");
