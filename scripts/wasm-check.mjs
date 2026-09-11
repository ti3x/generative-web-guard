// Smoke and differential test for the Lean checker compiled to WebAssembly.
//
//   npm run wasm:build           # builds lean/wasm/dist/guard.mjs + guard.wasm
//   node scripts/wasm-check.mjs  # corpus + FUZZ random cases (default 500), compared to policy.js
import { parseHtmlToRaw } from "../src/adapters/parse5.js";
import { jsEngine, wasmEngine, compareSummaries, DEFAULT_CLASSES } from "./lib/engines.mjs";
import { CORPUS, randomHtml, rng } from "./lean-differential.mjs";

const wasm = wasmEngine();
if (!wasm.available()) {
  console.error("lean/wasm/dist/guard.mjs not found; run: npm run wasm:build");
  process.exit(2);
}
const FUZZ = Number(process.env.FUZZ || 500);
const r = rng(Number(process.env.SEED || 1));
const cases = [...CORPUS, ...Array.from({ length: FUZZ }, () => randomHtml(r))];
const raws = cases.map((html) => parseHtmlToRaw(html));

const t0 = performance.now();
const js = await jsEngine.run(raws, DEFAULT_CLASSES);
const t1 = performance.now();
const w = await wasm.run(raws, DEFAULT_CLASSES);
const t2 = performance.now();
const mismatches = compareSummaries(js, w, cases);
for (const m of mismatches.slice(0, 10)) console.log(`MISMATCH ${m.diff}\n  ${JSON.stringify(m.label).slice(0, 160)}`);
console.log(`wasm: ${(wasm.sizeBytes() / 1024 / 1024).toFixed(2)} MiB`);
console.log(`${cases.length} cases (${CORPUS.length} corpus + ${FUZZ} random): js ${(t1 - t0).toFixed(1)} ms, wasm ${(t2 - t1).toFixed(1)} ms incl. instantiation`);
console.log(`${mismatches.length} mismatch(es) against policy.js (status, tree, change kinds and rule ids)`);
process.exit(mismatches.length ? 1 : 0);
