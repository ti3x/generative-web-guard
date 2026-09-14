// Reproducible browser measurements against the exact assembled distribution.
// One engine per invocation; run before and after rebuilding the checker.
// RSS is the aggregate of this process's browser descendants, sampled every
// 25 ms. It includes browser overhead and is NOT a Wasm allocation theorem.
import { chromium, firefox, webkit } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

const engine = process.env.ENGINES || "chromium";
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library/Caches/ms-playwright");
const engines = {
  chromium: [chromium, "chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium", "140.0.7339.186"],
  firefox: [firefox, "firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox", "141.0"],
  webkit: [webkit, "webkit-2203/pw_run.sh", "26.0"],
};
if (!engines[engine]) throw new Error("Select one of chromium, firefox, webkit with ENGINES");
const [type, relative, expectedVersion] = engines[engine];
const base = new URL(process.env.DEMO_URL || "http://localhost:8096/");
const bundle = new URL("/generative-web-guard.full.min.js", process.env.CDN_URL || `http://127.0.0.1:${Number(base.port) + 1}`).href;
const repetitions = 5;

function rss() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .trim().split("\n").map(line => {
      const [, pid, ppid, kb, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) || [];
      return { pid: Number(pid), ppid: Number(ppid), kb: Number(kb), command };
    });
  const descendants = new Set([process.pid]);
  let added;
  do {
    added = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
      descendants.add(row.pid); added = true;
    }
  } while (added);
  return rows.filter(row => row.pid !== process.pid && descendants.has(row.pid) && !/\/ps$/.test(row.command))
    .reduce((sum, row) => sum + row.kb * 1024, 0);
}

const samples = [];
for (let iteration = 0; iteration < repetitions; iteration++) {
  const browser = await type.launch({ executablePath: process.env.BROWSER_PATH || join(cache, relative), headless: true });
  let sampler;
  try {
    if (browser.version() !== expectedVersion) throw new Error(`Unexpected ${engine} version: ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto(new URL("/demo/benchmark.html", base).href);
    const idleRssBytes = rss();
    let peakRssBytes = idleRssBytes;
    sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, rss()); }, 25);
    const result = await page.evaluate(async ({ bundle }) => {
      const copies = { htmlToWorker: 0, treeToWorker: 0, treeToHost: 0, renderedToHost: 0, treeToFrame: 0 };
      const OriginalWorker = globalThis.Worker;
      globalThis.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data?.tree) copies.treeToHost++;
            if (data?.status === "rendered") copies.renderedToHost++;
          });
        }
        postMessage(data, ...rest) {
          if (typeof data?.html === "string") copies.htmlToWorker++;
          if (data?.tree) copies.treeToWorker++;
          return super.postMessage(data, ...rest);
        }
      };
      const begin = performance.now();
      const { createGuard } = await import(bundle);
      const guard = await createGuard({ container: document.querySelector("#mount") });
      const readyMs = performance.now() - begin;
      const typical = '<div class="card"><h2>Quarterly revenue</h2><p>Revenue increased by 12%.</p><svg viewBox="0 0 100 50"><rect width="80" height="20" fill="blue"></rect></svg></div>';
      // 4,999 nodes: 50 groups of 99 nodes and one group of 49. The
      // alternating tags prevent HTML text-node coalescing. Depth is 3,
      // and the open-node count stays below the measured preprocessing cap.
      const group = n => '<div>' + '<span>x</span>'.repeat((n - 1) / 2) + '</div>';
      const maximumNodes = group(99).repeat(50) + '<div>' + '<span></span>'.repeat(48) + '</div>';
      const cases = { typical, maximumNodes, maximumText: ('<p>' + 'x'.repeat(20000) + '</p>').repeat(10) };
      const render = {};
      for (const [name, html] of Object.entries(cases)) {
        const times = [];
        for (let i = 0; i < 12; i++) {
          const start = performance.now();
          const answer = await guard.render({ html });
          if (answer.status !== "rendered") throw new Error(`${name}: ${JSON.stringify(answer)}`);
          copies.treeToFrame = answer.stats?.frameTreeMessages ?? copies.treeToFrame;
          if (i >= 2) times.push(performance.now() - start);
        }
        render[name] = times;
      }
      guard.dispose();
      return { readyMs, render, messageCopies: copies, decompressionStream: typeof DecompressionStream === "function" };
    }, { bundle });
    peakRssBytes = Math.max(peakRssBytes, rss());
    samples.push({ ...result, idleRssBytes, peakRssBytes });
    console.log(`${engine} sample ${iteration + 1}/${repetitions}: ready ${result.readyMs.toFixed(1)} ms, peak RSS ${(peakRssBytes / 1048576).toFixed(1)} MiB`);
  } finally {
    clearInterval(sampler);
    await browser.close();
  }
}
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const summary = xs => ({ medianMs: percentile(xs, .5), p95Ms: percentile(xs, .95), samples: xs.length });
const files = ["lean/wasm/dist/guard.wasm", "cdn/policy-worker.min.js", "cdn/generative-web-guard.full.min.js"];
const report = {
  label: process.env.RUN_LABEL || "measurement", engine, version: expectedVersion,
  checker: JSON.parse(readFileSync("cdn/asset-manifest.json", "utf8")).checker,
  methodology: "Five fresh browser processes. Cold startup includes bundle import and createGuard. Ten measured renders per case after two warmups. Browser-descendant aggregate RSS sampled at 25 ms; includes browser overhead.",
  cold: summary(samples.map(s => s.readyMs)),
  renders: Object.fromEntries(Object.keys(samples[0].render).map(name => [name, summary(samples.flatMap(s => s.render[name]))])),
  peakRssBytes: Math.max(...samples.map(s => s.peakRssBytes)),
  assets: Object.fromEntries(files.map(path => {
    const bytes = readFileSync(path);
    return [path, { bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, brotliBytes: brotliCompressSync(bytes).length }];
  })),
  samples,
};
if (process.env.REPORT_PATH) writeFileSync(process.env.REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
