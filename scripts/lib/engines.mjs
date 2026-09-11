// Shared "engines" for differential testing: the JavaScript policy, the Lean
// checker running natively in Docker, and the Lean checker compiled to
// WebAssembly. Used by scripts/lean-differential.mjs, scripts/wasm-check.mjs
// and the Cucumber step definitions.
//
// Every engine has the same shape:
//   { name, available(): boolean, run(raws, classes): Promise<summary[]> }
// where a summary is
//   { status: "validated", tree, changes: n, kinds: [...], rules: [...] }
//   { status: "rejected", reasons: [...] }
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkTree, setClassAllowlist } from "../../src/policy.js";

export const DEFAULT_CLASSES = ["card", "muted", "bar", "btn", "row", "stack", "title", "label", "axis", "chart"];

const LEAN_DIR = new URL("../../lean", import.meta.url).pathname;
const WASM_MJS = new URL("../../lean/wasm/dist/guard.mjs", import.meta.url);
const WASM_BIN = new URL("../../lean/wasm/dist/guard.wasm", import.meta.url);

// Deep-sort object keys so key order (which differs between JSON emitters)
// never counts as a difference.
export function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]));
  return x;
}

export function firstDiff(a, b, path = "") {
  if (JSON.stringify(canon(a)) === JSON.stringify(canon(b))) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], `${path}/${k}`);
    if (d) return d;
  }
  return `${path}: differ`;
}

// JavaScript checkTree result -> summary
export function summarizeJs(result) {
  return result.status === "validated"
    ? { status: "validated", tree: result.tree, changes: result.changes.length,
        kinds: result.changes.map((c) => c.kind), rules: result.changes.map((c) => c.rule ?? "") }
    : { status: "rejected", reasons: result.reasons.map((r) => r.code) };
}

// Lean JSON response entry -> summary
export function summarizeLean(entry) {
  return entry.status === "validated"
    ? { status: "validated", tree: entry.tree, changes: entry.changes,
        kinds: entry.changeKinds ?? [], rules: entry.changeRules ?? [] }
    : { status: "rejected", reasons: entry.reasons ?? [] };
}

export const jsEngine = {
  name: "js",
  available: () => true,
  async run(raws, classes = DEFAULT_CLASSES) {
    setClassAllowlist(classes);
    return raws.map((raw) => summarizeJs(checkTree(raw)));
  },
};

// Lean checker in Docker. Honours:
//   GUARD_LEAN_IMAGE            image with the checker entrypoint (default guard-lean)
//   GUARD_LEAN_MOUNT=1          run the binary built in lean/.lake through the toolchain image instead
//   GUARD_LEAN_TOOLCHAIN_IMAGE  toolchain image for the mount mode (default guard-lean-toolchain)
//   NEGATIVE_CONTROL=1          send a different class list so the engines must disagree
const LOCAL_BINARY = `${LEAN_DIR}/.lake/build/bin/guard`;
const imageExists = (name) => spawnSync("docker", ["image", "inspect", name], { encoding: "utf8" }).status === 0;

export function leanDockerEngine(env = process.env) {
  const image = env.GUARD_LEAN_IMAGE || "guard-lean";
  const toolchain = env.GUARD_LEAN_TOOLCHAIN_IMAGE || "guard-lean-toolchain";
  // Mount mode runs the binary built from the sources on disk. It is used when
  // asked for, or automatically when the checker image is missing but a local
  // build exists, so a stale or broken image never silently takes part.
  const mount = env.GUARD_LEAN_MOUNT === "1" || (env.GUARD_LEAN_MOUNT !== "0" && !imageExists(image) && existsSync(LOCAL_BINARY));
  const args = mount
    ? ["run", "-i", "--rm", "-v", `${LEAN_DIR}:/guard`, toolchain, "/guard/.lake/build/bin/guard"]
    : ["run", "-i", "--rm", image];
  const target = mount ? toolchain : image;
  return {
    name: "lean",
    available: () => imageExists(target) && (!mount || existsSync(LOCAL_BINARY)),
    async run(raws, classes = DEFAULT_CLASSES) {
      const sent = env.NEGATIVE_CONTROL ? classes.filter((c) => c !== "card") : classes;
      const input = JSON.stringify({ classes: sent, inputs: raws });
      const proc = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (proc.status !== 0) throw new Error(`lean checker failed: ${proc.stderr || proc.stdout}`);
      return JSON.parse(proc.stdout).map(summarizeLean);
    },
  };
}

// Lean checker compiled to WebAssembly, instantiated once and reused.
export function wasmEngine() {
  let modulePromise = null;
  const load = () => {
    if (!modulePromise) {
      modulePromise = (async () => {
        const createGuard = (await import(pathToFileURL(WASM_MJS.pathname).href)).default;
        const Module = await createGuard();
        const init = Module.cwrap("guard_init", "number", []);
        const check = Module.cwrap("guard_check_c", "number", ["string"]);
        const free = Module.cwrap("guard_free", null, ["number"]);
        if (init() !== 0) throw new Error("wasm: lean runtime failed to initialize");
        return { Module, check, free };
      })();
    }
    return modulePromise;
  };
  return {
    name: "wasm",
    available: () => existsSync(WASM_MJS) && existsSync(WASM_BIN),
    sizeBytes: () => (existsSync(WASM_BIN) ? statSync(WASM_BIN).size : 0),
    async run(raws, classes = DEFAULT_CLASSES) {
      const { Module, check, free } = await load();
      const ptr = check(JSON.stringify({ classes, inputs: raws }));
      const out = Module.UTF8ToString(ptr);
      free(ptr);
      return JSON.parse(out).map(summarizeLean);
    },
  };
}

// Returns exactly the engines named in `engines` (comma-separated list or
// array; env ENGINES, default "js"). Every named engine must be available,
// otherwise this throws, so CI can insist on all three with ENGINES=js,lean,wasm.
// Engines are selected explicitly rather than "whatever is available" so that
// a stale local Docker image cannot silently take part in a run.
export async function loadEngines({ engines = process.env.ENGINES ?? "js", env = process.env } = {}) {
  const wanted = (Array.isArray(engines) ? engines : String(engines).split(",")).map((s) => s.trim()).filter(Boolean);
  if (!wanted.includes("js")) wanted.unshift("js");
  const all = { js: jsEngine, lean: leanDockerEngine(env), wasm: wasmEngine() };
  const selected = [];
  const missing = [];
  for (const name of wanted) {
    const engine = all[name];
    if (!engine) throw new Error(`unknown engine ${name}`);
    let ok = false;
    try { ok = engine.available(); } catch { ok = false; }
    if (ok) selected.push(engine); else missing.push(name);
  }
  if (missing.length) throw new Error(`requested engines not available: ${missing.join(", ")}`);
  return selected;
}

// Compare one engine's summaries against the JS engine's. Returns mismatch list.
export function compareSummaries(reference, other, labels = []) {
  const mismatches = [];
  reference.forEach((a, i) => {
    const d = firstDiff(a, other[i]);
    if (d) mismatches.push({ index: i, label: labels[i], diff: d });
  });
  return mismatches;
}
