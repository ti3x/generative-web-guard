// Focused diagnosis: which directive blocks a *static* top-level import inside
// a blob: module worker? Prints every console message so the engine's own CSP
// text is visible.
import { chromium, firefox, webkit } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const cache = join(homedir(), "Library/Caches/ms-playwright");
function chromiumExe() {
  for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    const p = join(cache, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
    if (existsSync(p)) return p;
  }
}
const CDN = "http://127.0.0.1:8095";
const CASES = {
  "A script-src with blob:": `default-src 'none'; script-src 'self' ${CDN} blob:; worker-src 'self' blob:; connect-src ${CDN}`,
  "B default-src only with blob:": `default-src 'self' ${CDN} blob:`,
  "C default-src blob: plus worker-src": `default-src 'self' ${CDN} blob:; worker-src 'self' blob:`,
  "D script-src only, no default-src": `script-src 'self' ${CDN} blob:; worker-src 'self' blob:`,
  "E default-src none + script-src-elem": `default-src 'none'; script-src 'self' ${CDN} blob:; script-src-elem 'self' ${CDN} blob:; worker-src 'self' blob:; connect-src ${CDN}`,
  "F script-src + connect-src blob:": `default-src 'none'; script-src 'self' ${CDN} blob:; worker-src 'self' blob:; connect-src ${CDN} blob:`,
  "G cdn in worker-src, NOT in script-src": `default-src 'none'; script-src 'self' blob:; worker-src 'self' blob: ${CDN}; connect-src ${CDN}`,
  "H cdn in both worker-src and script-src": `default-src 'none'; script-src 'self' ${CDN} blob:; worker-src 'self' blob: ${CDN}; connect-src ${CDN}`,
  "I cdn in script-src, worker-src without blob:": `default-src 'none'; script-src 'self' ${CDN} blob:; worker-src 'self' ${CDN}; connect-src ${CDN}`,
};
const engine = process.env.ENGINE || "chromium";
const browser = engine === "firefox" ? await firefox.launch({ headless: true })
  : engine === "webkit" ? await webkit.launch({ headless: true })
  : await chromium.launch({ headless: true, executablePath: chromiumExe() });
console.log(engine, browser.version());
for (const [label, csp] of Object.entries(CASES)) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const msgs = [];
  page.on("console", (m) => msgs.push(`${m.type()}@${m.location().url}: ${m.text().slice(0, 220)}`));
  await page.goto(`http://localhost:8094/diag.html?csp64=${Buffer.from(csp).toString("base64url")}`);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 20000 });
  const r = await page.evaluate(() => window.__result);
  console.log(`\n[${label}]\n  csp: ${csp}\n  static=${JSON.stringify(r.static)}\n  dynamic=${JSON.stringify(r.dynamic)}\n  violations=${JSON.stringify(r.violations)}`);
  for (const m of msgs) console.log("   console:", m);
  await ctx.close();
}
await browser.close();
