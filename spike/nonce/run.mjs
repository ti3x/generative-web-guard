// Driver for the nonce / 'strict-dynamic' spike. Independent copy of the
// spike/run.mjs pattern, with one difference that matters: the engine build is
// PINNED and its reported version is ASSERTED. A previous agent was misled by
// an unpinned launcher that picked Chromium 153 / Firefox 146 out of the local
// cache, so "newest cached build" is not acceptable here.
//
//   node spike/nonce/serve.mjs &
//   ENGINES=chromium PAGES=n1 node spike/nonce/run.mjs
import { chromium, firefox, webkit } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { N1_VARIANTS, N1_NO_HOST_NONCE, N2_VARIANTS, N3_VARIANTS, N3_FRAME_NONCE, N4_VARIANTS } from "./csp-variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HOST_URL || "http://localhost:8098";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright"));

// Exactly the pinned set scripts/browser-check.mjs asserts.
const ENGINES = {
  chromium: {
    type: chromium,
    revisions: [{ revision: "1193", version: "140.0.7339.186" }],
    relative: ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome"],
  },
  firefox: {
    type: firefox,
    revisions: [{ revision: "1490", version: "141.0" }],
    relative: ["firefox/Nightly.app/Contents/MacOS/firefox", "firefox/firefox"],
  },
  webkit: {
    type: webkit,
    revisions: [{ revision: "2203", version: "26.0" }],
    relative: ["pw_run.sh"],
  },
};

function resolveExecutable(name) {
  const spec = ENGINES[name];
  const tried = [];
  for (const pin of spec.revisions) {
    for (const rel of spec.relative) {
      const candidate = join(pwCache, `${name}-${pin.revision}`, rel);
      tried.push(candidate);
      if (existsSync(candidate)) return { path: candidate, pinned: pin };
    }
  }
  throw new Error(`${name}: pinned revision not installed. Tried:\n  ${tried.join("\n  ")}`);
}

async function runVariant(browser, pageName, cspName, csp, extraQuery = "") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMsgs = [];
  const pageErrors = [];
  page.on("console", (m) => consoleMsgs.push({ type: m.type(), url: m.location().url, text: m.text().slice(0, 300) }));
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const nonce = randomBytes(16).toString("base64url");
  const record = { cspName, csp, nonce, consoleMsgs, pageErrors };
  const url = `${BASE}/${pageName}?csp64=${b64(csp)}&nonce=${encodeURIComponent(nonce)}${extraQuery}`;
  record.url = url;
  try {
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
    await page.waitForFunction(() => window.__done === true, null, { timeout: 45000 });
    record.result = await page.evaluate(() => window.__result);
  } catch (e) {
    record.driverError = String(e.message).slice(0, 300);
    try { record.result = await page.evaluate(() => window.__result || null); } catch { /* nothing to read */ }
  }
  if (pageName === "n3.html" || pageName === "n4.html") {
    // Independent evidence: read the opaque frame directly rather than trust
    // what the page reported about it.
    try {
      const frame = page.frames().find((f) => f !== page.mainFrame());
      record.frameSeenByDriver = frame
        ? await frame.evaluate(() => ({
            origin: String(location.origin),
            rootText: document.getElementById("root") ? document.getElementById("root").textContent : null,
            // Did the frame's hash-pinned stylesheet apply?
            rootColor: document.getElementById("root") ? getComputedStyle(document.getElementById("root")).color : null,
            rootFont: document.getElementById("root") ? getComputedStyle(document.getElementById("root")).fontSize : null,
            scriptRan: typeof window.__frameStats !== "undefined",
            stats: window.__frameStats ? JSON.parse(JSON.stringify(window.__frameStats)) : null,
          }))
        : { missing: true };
    } catch (e) {
      record.frameSeenByDriver = { error: String(e.message).slice(0, 200) };
    }
  }
  await context.close();
  return record;
}

const PAGES = (process.env.PAGES || "n1,n2,n3,n4").split(",").map((s) => s.trim()).filter(Boolean);
// ONLY=<cspName>[,...] restricts the run to named variants; previous results
// for other variants are preserved from the existing results file.
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((x) => x.trim())) : null;
const engines = (process.env.ENGINES || "chromium,firefox,webkit").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(join(here, "results"), { recursive: true });

for (const name of engines) {
  const { path, pinned } = resolveExecutable(name);
  const browser = await ENGINES[name].type.launch({ executablePath: path, headless: true });
  const version = browser.version();
  if (version !== pinned.version) {
    await browser.close();
    throw new Error(`${name}: expected pinned ${pinned.version} (revision ${pinned.revision}), got ${version}. Refusing to record results from an unpinned build.`);
  }
  const resultFile = join(here, "results", `${name}.json`);
  let prev = {};
  try { prev = JSON.parse(readFileSync(resultFile, "utf8")); } catch { /* first run */ }
  const out = {
    engine: name, version, revision: pinned.revision, executable: path,
    when: new Date().toISOString(),
    n1: prev.n1 || {}, n2: prev.n2 || {}, n3: prev.n3 || {}, n4: prev.n4 || {},
  };
  console.log(`\n=== ${name} ${version} (pinned revision ${pinned.revision}) ===`);

  if (PAGES.includes("n1")) {
    for (const [cspName, csp] of Object.entries(N1_VARIANTS)) {
      if (only && !only.has(cspName)) continue;
      for (const hostNonce of N1_NO_HOST_NONCE.includes(cspName) ? [1, 0] : [1]) {
        const key = hostNonce ? cspName : `${cspName}/no-host-nonce`;
        process.stdout.write(`n1 ${key} ... `);
        const rec = await runVariant(browser, "n1.html", cspName, csp, `&hostNonce=${hostNonce}`);
        out.n1[key] = rec;
        const r = rec.result || {};
        const t = r.tags || {};
        console.log(`hostModule=${!!(r.steps && r.steps.hostModuleRan)} tags=[${Object.keys(t).sort().join(",")}] dynImport=${r.steps && r.steps.dynamicImportFromHostModule ? r.steps.dynamicImportFromHostModule.ok : "-"} insert=${r.steps && r.steps.programmaticInsert}`);
        writeFileSync(resultFile, JSON.stringify(out, null, 1));
      }
    }
  }
  if (PAGES.includes("n2")) {
    for (const [cspName, csp] of Object.entries(N2_VARIANTS)) {
      if (only && !only.has(cspName)) continue;
      process.stdout.write(`n2 ${cspName} ... `);
      const rec = await runVariant(browser, "n2.html", cspName, csp);
      out.n2[cspName] = rec;
      const s = (rec.result || {}).steps || {};
      const c = s.blobClassic || {};
      const m = s.blobModule || {};
      console.log(`classic(created=${c.created},top=${c.topLevelRan},wasmInst=${c.probe && c.probe.wasmInstantiate},err=${c.errorEvent}) module(top=${m.topLevelRan},dynImport=${m.probe && m.probe.dynamicImport})`);
      writeFileSync(resultFile, JSON.stringify(out, null, 1));
    }
  }
  if (PAGES.includes("n3")) {
    for (const [cspName, csp] of Object.entries(N3_VARIANTS)) {
      if (only && !only.has(cspName)) continue;
      for (const frameNonce of N3_FRAME_NONCE.includes(cspName) ? [0, 1] : [0]) {
        const key = frameNonce ? `${cspName}/frame-nonce` : cspName;
        process.stdout.write(`n3 ${key} ... `);
        const rec = await runVariant(browser, "n3.html", cspName, csp, `&frameNonce=${frameNonce}`);
        out.n3[key] = rec;
        const s = (rec.result || {}).steps || {};
        const f = rec.frameSeenByDriver || {};
        console.log(`frameScriptRan=${f.scriptRan} alive=${s.frameAlive && !s.frameAlive.timeout} committed=${!!(s.committed && !s.committed.timeout)} root="${String(f.rootText || "").slice(0, 24)}" font=${f.rootFont} violations=${((rec.result || {}).violations || []).length}`);
        writeFileSync(resultFile, JSON.stringify(out, null, 1));
      }
    }
  }
  if (PAGES.includes("n4")) {
    for (const [cspName, csp] of Object.entries(N4_VARIANTS)) {
      if (only && !only.has(cspName)) continue;
      process.stdout.write(`n4 ${cspName} ... `);
      const rec = await runVariant(browser, "n4.html", cspName, csp);
      out.n4[cspName] = rec;
      const s = (rec.result || {}).steps || {};
      const e = s.e2e || {};
      const st = e.steps || {};
      console.log(`import=${s.cdnGuardImport && s.cdnGuardImport.ok} worker=${st.policyWorkerCreate} wasm=${st.policyWorkerWasm && st.policyWorkerWasm.wasmSync} render=${st.render ? st.render.outcome || JSON.stringify(st.render) : "-"} ms=${st.renderMs}`);
      writeFileSync(resultFile, JSON.stringify(out, null, 1));
    }
  }
  writeFileSync(resultFile, JSON.stringify(out, null, 1));
  await browser.close();
}
console.log("\nwrote spike/nonce/results/*.json");
