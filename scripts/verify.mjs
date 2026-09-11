// npm test is the full verification path. Missing Lean/Wasm is a failure.
// npm run test:js is an explicitly limited, faster development check.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const leanDir = fileURLToPath(new URL("../lean", import.meta.url));
const env = { ...process.env, GUARD_LEAN_MOUNT: "1", GUARD_REQUIRE_LEAN: "1", GUARD_SKIP_LEAN: "0", ENGINES: "js,lean,wasm" };
const local = process.argv.includes("--js-only");
if (local) Object.assign(env, { ENGINES: "js", GUARD_SKIP_LEAN: "1", GUARD_REQUIRE_LEAN: "0" });
function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const r = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (r.error || r.status !== 0) {
    console.error(r.error?.message ?? `verification stopped (${r.status})`);
    process.exit(r.status || 1);
  }
}
const node = (...args) => run(process.execPath, args);
node("scripts/gen-rules.mjs", "--check");
node("scripts/gen-policy.mjs", "--check");
if (!local) {
  for (const target of [env.GUARD_LEAN_TOOLCHAIN_IMAGE || "guard-lean-toolchain", env.GUARD_LEAN_WASM_IMAGE || "guard-lean-wasm"]) {
    const r = spawnSync("docker", ["image", "inspect", target], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`Full verification requires ${target}. Start Docker and run npm run setup:verification.\n${r.stderr ?? ""}`);
      process.exit(1);
    }
  }
  run("docker", ["run", "--rm", "-v", `${leanDir}:/guard`, env.GUARD_LEAN_TOOLCHAIN_IMAGE || "guard-lean-toolchain", "sh", "-c", "lake build Guard guard Tests guard-tests && lake exe guard-tests"]);
  node("scripts/check-proofs.mjs");
  run("docker", ["run", "--rm", "-v", `${leanDir}:/guard`, env.GUARD_LEAN_WASM_IMAGE || "guard-lean-wasm"]);
}
node("--test", "test/*.test.js");
run(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "cucumber-js"]);
node("scripts/check-policy-properties.mjs");
node("scripts/rule-coverage.mjs");
console.log(local ? "\nJS development checks passed. Lean proofs and cross-engine behavior were NOT verified." : "\nFull verification passed: fresh Lean + Wasm, theorem audit, unit + BDD + behavioral checks.");
