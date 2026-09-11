// Resolve every advertised proof in Lean's environment, require a theorem,
// and reject any transitive axiom outside Lean's three foundational axioms.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./gen-rules.mjs";

const leanDir = fileURLToPath(new URL("../lean/", import.meta.url));
const names = [...new Set(loadCatalog().rules.flatMap(r => r.proofs))];
if (!names.length) throw new Error("no advertised theorems to audit");
for (const name of names) if (!/^Guard\.Props\.[A-Za-z0-9_]+$/.test(name)) throw new Error(`invalid theorem name ${name}`);

// Source-level declarations are checked as well: an unused axiom or admitted
// proof must not hide outside the catalog. Comments do not count as code.
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) scan(path);
    else if (entry.name.endsWith(".lean")) {
      const code = readFileSync(path, "utf8").replace(/\/-[\s\S]*?-\//g, "").replace(/--[^\n]*/g, "");
      if (/\b(sorry|admit|axiom|native_decide)\b/.test(code)) throw new Error(`unapproved proof escape in ${path}`);
    }
  }
}
scan(`${leanDir}/Guard`);

const input = `import Lean\nimport Guard\n\nopen Lean Elab Command in\nrun_cmd do\n` +
  names.map(n => '  match (← getConstInfo `' + n + ') with\n  | .thmInfo _ => pure ()\n  | _ => throwError "' + n + ' is not a theorem"').join("\n") + "\n\n" +
  names.map(n => `#print axioms ${n}`).join("\n") + "\n";
const proc = spawnSync("docker", ["run", "--rm", "-i", "-v", `${leanDir}:/guard`, process.env.GUARD_LEAN_TOOLCHAIN_IMAGE || "guard-lean-toolchain", "lake", "env", "lean", "--stdin"], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (proc.error || proc.status !== 0) throw new Error(`Lean proof audit failed:\n${proc.error ?? ""}${proc.stdout}${proc.stderr}`);
const allowed = new Set(["propext", "Classical.choice", "Quot.sound"]);
for (const name of names) {
  const escaped = name.replaceAll(".", "\\.");
  const m = proc.stdout.match(new RegExp(`'${escaped}' (does not depend on any axioms|depends on axioms: \\[([^\\]]*)\\])`));
  if (!m) throw new Error(`missing axiom report for ${name}: ${proc.stdout}`);
  for (const axiom of (m[2] ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    if (!allowed.has(axiom)) throw new Error(`${name} depends on unapproved axiom ${axiom}`);
  }
}
console.log(`proof audit: ${names.length} compiled theorems; only foundational axioms`);
