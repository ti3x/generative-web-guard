// Build: bundle the frame script, the QuickJS worker and the demo; extract the
// class allowlist from the bundled stylesheet; hash script and CSS for the
// frame CSP; write dist/frame-manifest.json.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(rootDir, "dist");
const cdn = resolve(rootDir, "cdn");
mkdirSync(dist, { recursive: true });
mkdirSync(cdn, { recursive: true });

const css = readFileSync(resolve(rootDir, "demo/app.css"), "utf8");
// Every class selector in the bundled stylesheet is a permitted class name.
const classes = Array.from(new Set(Array.from(css.matchAll(/\.([A-Za-z_][\w-]*)/g), (m) => m[1]))).sort();

const frame = await build({
  entryPoints: [resolve(rootDir, "src/frame.js")],
  bundle: true,
  format: "iife",
  write: false,
  minify: false,
  target: ["es2020"],
  define: { __CLASS_ALLOWLIST__: JSON.stringify(classes) },
});
let script = frame.outputFiles[0].text;
// The script is inlined into a <script> element; make sure it can never close it.
if (/<\/script/i.test(script)) throw new Error("frame bundle contains </script");
if (/<\/style/i.test(css)) throw new Error("stylesheet contains </style");

const sha256b64 = (s) => createHash("sha256").update(s, "utf8").digest("base64");
const manifest = {
  script,
  css,
  classes,
  scriptHash: sha256b64(script),
  cssHash: sha256b64(css),
};
writeFileSync(resolve(dist, "frame-manifest.json"), JSON.stringify(manifest));
writeFileSync(resolve(dist, "frame-manifest.js"), "export default " + JSON.stringify(manifest) + ";\n");

const worker = await build({
  entryPoints: [resolve(rootDir, "src/runtime/worker.js")],
  bundle: true,
  format: "iife",
  write: false,
  target: ["es2020"],
  platform: "browser",
});
const workerSource = worker.outputFiles[0].text;
writeFileSync(resolve(dist, "worker.js"), workerSource);

const workerMin = await build({
  entryPoints: [resolve(rootDir, "src/runtime/worker.js")],
  bundle: true,
  format: "iife",
  write: false,
  minify: true,
  target: ["es2020"],
  platform: "browser",
});
const workerMinSource = workerMin.outputFiles[0].text;
writeFileSync(resolve(cdn, "worker.min.js"), workerMinSource);

for (const minify of [false, true]) {
  await build({
    entryPoints: [resolve(rootDir, "src/cdn.js")],
    bundle: true,
    format: "esm",
    outfile: resolve(cdn, `generative-web-guard${minify ? ".min" : ""}.js`),
    minify,
    target: ["es2020"],
    platform: "browser",
  });
}

await build({
  entryPoints: [resolve(rootDir, "src/cdn-full.js")],
  bundle: true,
  format: "esm",
  outfile: resolve(cdn, "generative-web-guard.full.min.js"),
  minify: true,
  target: ["es2020"],
  platform: "browser",
  plugins: [{
    name: "embedded-worker",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^guard:worker-source$/ }, () => ({ path: "worker", namespace: "guard" }));
      buildApi.onLoad({ filter: /^worker$/, namespace: "guard" }, () => ({
        contents: `export default ${JSON.stringify(workerMinSource)}`,
        loader: "js",
      }));
    },
  }],
});

await build({
  entryPoints: [resolve(rootDir, "demo/main.js")],
  bundle: true,
  format: "esm",
  outfile: resolve(dist, "demo.js"),
  target: ["es2020"],
  platform: "browser",
});

await build({
  entryPoints: [resolve(rootDir, "demo/showcase.js")],
  bundle: true,
  format: "esm",
  outfile: resolve(dist, "showcase.js"),
  target: ["es2020"],
  platform: "browser",
});

console.log(`built: frame ${script.length} bytes, ${classes.length} classes, worker + demos + CDN modules`);
