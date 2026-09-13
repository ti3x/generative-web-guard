// Spike driver. Runs the q1/q2 harness pages on Chromium, Firefox and WebKit
// under each CSP variant and writes spike/results/<engine>.json.
//
//   node spike/serve.mjs &            # host :8094, cdn :8095
//   node spike/run.mjs                # all engines
//   ENGINES=webkit node spike/run.mjs # one engine
import { chromium, firefox, webkit } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Q1_VARIANTS, Q2_VARIANTS, Q3_VARIANTS } from "./csp-variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HOST_URL || "http://localhost:8094";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const cache = join(homedir(), "Library/Caches/ms-playwright");

function newestCachedChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const p of [
      join(cache, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
      join(cache, d, "chrome-linux/chrome"),
    ]) if (existsSync(p)) return p;
  }
  return undefined;
}

const launchers = {
  chromium: () => chromium.launch({ headless: true, executablePath: newestCachedChromium() }),
  firefox: () => firefox.launch({ headless: true }),
  webkit: () => webkit.launch({ headless: true }),
};

async function runVariant(browser, pageName, cspName, csp, extraQuery = "") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMsgs = [];
  const pageErrors = [];
  page.on("console", (m) => consoleMsgs.push({ type: m.type(), url: m.location().url, text: m.text().slice(0, 300) }));
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const record = { cspName, csp, consoleMsgs, pageErrors };
  try {
    await page.goto(`${BASE}/${pageName}?csp64=${b64(csp)}${extraQuery}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.__done === true, null, { timeout: 90000 });
    record.result = await page.evaluate(() => window.__result);
  } catch (e) {
    record.driverError = String(e.message).slice(0, 400);
    try { record.result = await page.evaluate(() => window.__result || null); } catch (e2) {}
  }
  if (pageName === "q1.html") {
    // Independent evidence: read the opaque frame directly instead of trusting
    // what the page reported.
    try {
      const frame = page.frames().find((f) => f !== page.mainFrame());
      record.frameSeenByDriver = frame
        ? await frame.evaluate(() => ({
            origin: String(location.origin),
            rootText: document.getElementById("root") ? document.getElementById("root").textContent : null,
            stats: window.__frameStats ? JSON.parse(JSON.stringify(window.__frameStats)) : null,
          }))
        : { missing: true };
    } catch (e) {
      record.frameSeenByDriver = { error: String(e.message).slice(0, 300) };
    }
  }
  await context.close();
  return record;
}

const PAGES = (process.env.PAGES || "q1,q2,q3").split(",").map((s) => s.trim());
const engines = (process.env.ENGINES || "chromium,firefox,webkit").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(join(here, "results"), { recursive: true });

for (const name of engines) {
  const browser = await launchers[name]();
  const resultFile = join(here, "results", `${name}.json`);
  let prev = {};
  try { prev = JSON.parse(readFileSync(resultFile, "utf8")); } catch (e) {}
  const out = { engine: name, version: browser.version(), when: new Date().toISOString(),
    q1: prev.q1 || {}, q2: prev.q2 || {}, q3: prev.q3 || {} };
  console.log(`\n=== ${name} ${browser.version()} ===`);
  for (const [cspName, csp] of PAGES.includes("q1") ? Object.entries(Q1_VARIANTS) : []) {
    process.stdout.write(`q1 ${cspName} ... `);
    out.q1[cspName] = await runVariant(browser, "q1.html", cspName, csp);
    const f = out.q1[cspName].frameSeenByDriver || {};
    console.log(`frame=${f.origin || "?"} root="${(f.rootText || "").slice(0, 40)}"`);
  }
  for (const [cspName, csp] of PAGES.includes("q2") ? Object.entries(Q2_VARIANTS) : []) {
    process.stdout.write(`q2 ${cspName} ... `);
    out.q2[cspName] = await runVariant(browser, "q2.html", cspName, csp);
    const r = out.q2[cspName].result || {};
    const cdnOk = r.steps && r.steps.cdnModuleImport && r.steps.cdnModuleImport.ok;
    const cases = (r.steps && r.steps.cdnDrivenCases) || {};
    const ok = Object.entries(cases).filter(([k, v]) => v && v.gotResult).map(([k]) => k);
    console.log(`cdnImport=${cdnOk} workersOk=[${ok.join(",")}]`);
  }
  for (const [cspName, csp] of PAGES.includes("q3") ? Object.entries(Q3_VARIANTS) : []) {
    for (const mode of ["blob", "shim"]) {
      process.stdout.write(`q3 ${cspName} mode=${mode} ... `);
      const rec = await runVariant(browser, "q3.html", cspName, csp, `&mode=${mode}`);
      out.q3[`${cspName}/${mode}`] = rec;
      const e = ((rec.result || {}).steps || {}).e2e || {};
      const st = e.steps || {};
      console.log(`import=${((rec.result||{}).steps||{}).cdnGuardImport?.ok} render=${st.render ? st.render.outcome || JSON.stringify(st.render) : "-"} wasm=${st.policyWorkerWasm ? st.policyWorkerWasm.wasmSync : "-"}`);
    }
  }
  writeFileSync(resultFile, JSON.stringify(out, null, 1));
  await browser.close();
}
console.log("\nwrote spike/results/*.json");
