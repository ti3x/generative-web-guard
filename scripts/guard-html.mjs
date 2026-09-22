// Validate untrusted HTML through the production candidate and Lean/Wasm
// authority, then serialize the exact accepted tree as canonical markup.
//
//   npm run guard:html -- page.html > page.filtered.html
//   npm run guard:html -- pages --out-dir filtered-pages
//
// This deliberately does not rewrite JavaScript. Generated programs belong in
// the QuickJS runtime; their *views* are HTML and can take this path.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLeanChecker } from "../src/lean-checker.js";
import { createPolicyCore } from "../src/policy-core.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmMjs = resolve(root, "lean/wasm/dist/guard.mjs");
const wasmBin = resolve(root, "lean/wasm/dist/guard.wasm");
const cssPath = resolve(root, "demo/app.css");
const VOID_HTML = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function frameConfiguration() {
  const css = readFileSync(cssPath, "utf8");
  const classes = Array.from(new Set(Array.from(css.matchAll(/\.([A-Za-z_][\w-]*)/g), match => match[1]))).sort();
  return { classes, stylesheetHash: createHash("sha256").update(css, "utf8").digest("base64") };
}

function escapeText(value) {
  return value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

function escapeAttribute(value) {
  return value.replace(/[&"<>]/g, char => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char]);
}

/** Serialize only the canonical tree the Lean authority returned. */
export function serializeAcceptedTree(tree) {
  if (!tree || tree.kind !== "root" || !Array.isArray(tree.children)) throw new TypeError("expected an accepted root tree");
  const render = node => {
    if (node?.kind === "text" && typeof node.text === "string") return escapeText(node.text);
    if (node?.kind !== "el" || typeof node.tag !== "string" || !Array.isArray(node.attrs) || !Array.isArray(node.children)) {
      throw new TypeError("authority returned a malformed tree");
    }
    const attrs = node.attrs.map(([name, value]) => {
      if (typeof name !== "string" || typeof value !== "string") throw new TypeError("authority returned a malformed attribute");
      return ` ${name}="${escapeAttribute(value)}"`;
    }).join("");
    const tag = node.tag;
    if (node.ns === "html" && VOID_HTML.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${node.children.map(render).join("")}</${tag}>`;
  };
  return tree.children.map(render).join("");
}

/** Create one sealed production checker for a CLI invocation. */
export async function createHtmlGuard() {
  if (!existsSync(wasmMjs) || !existsSync(wasmBin)) {
    throw new Error("Lean/Wasm checker is missing; run npm run wasm:build (or npm test) first");
  }
  const createModule = (await import(pathToFileURL(wasmMjs).href)).default;
  const { classes, stylesheetHash } = frameConfiguration();
  const checker = await createLeanChecker({
    createModule,
    wasmBinary: new Uint8Array(readFileSync(wasmBin)),
    classes,
    stylesheetHash,
  });
  return { core: createPolicyCore({ checker, classes }), checker, requestId: 0 };
}

/** Return the exact Lean-accepted markup or a structured refusal. */
export function filterHtml(guard, html) {
  if (!guard || !guard.core) throw new TypeError("a CLI guard is required");
  const requestId = ++guard.requestId;
  const result = guard.core.preprocess({
    html,
    instanceId: "cli",
    sessionId: "cli",
    generation: 0,
    requestId,
  });
  if (result.status !== "accepted") return result;
  return { ...result, html: serializeAcceptedTree(result.tree) };
}

function usage() {
  return [
    "Usage:",
    "  npm run guard:html -- INPUT.html > FILTERED.html",
    "  npm run guard:html -- - > FILTERED.html",
    "  npm run guard:html -- DIRECTORY --out-dir FILTERED_DIRECTORY",
    "  npm run guard:html -- INPUT.html --out FILTERED.html",
    "",
    "INPUT may be one .html/.htm file, - for standard input, or a directory.",
    "JavaScript is not rewritten. A <script> in HTML is removed; a separate",
    "generated program must run in the QuickJS runtime and its HTML view is what",
    "the policy accepts.",
  ].join("\n");
}

function parseArgs(argv) {
  let input = null, out = null, outDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--out") {
      out = argv[++i];
      if (!out || out.startsWith("-")) throw new Error("--out requires a path");
      continue;
    }
    if (arg === "--out-dir") {
      outDir = argv[++i];
      if (!outDir || outDir.startsWith("-")) throw new Error("--out-dir requires a path");
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    if (input) throw new Error("only one input path is allowed");
    input = arg;
  }
  if (!input) throw new Error("an input path is required");
  if (out && outDir) throw new Error("use either --out or --out-dir, not both");
  return { input, out, outDir };
}

function htmlFiles(directory) {
  const found = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && [".html", ".htm"].includes(extname(entry.name).toLowerCase())) found.push(child);
    }
  };
  walk(directory);
  return found.sort();
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) { console.error(`${error.message}\n\n${usage()}`); return 2; }
  if (args.help) { console.log(usage()); return 0; }

  const input = args.input === "-" ? "-" : resolve(args.input);
  if (input !== "-" && !existsSync(input)) {
    console.error(`input does not exist: ${args.input}`);
    return 2;
  }
  const isDirectory = input !== "-" && existsSync(input) && statSync(input).isDirectory();
  if (isDirectory && !args.outDir) {
    console.error("directory input requires --out-dir\n\n" + usage());
    return 2;
  }
  if (input === "-" && (args.out || args.outDir)) {
    console.error("standard input writes only to standard output\n\n" + usage());
    return 2;
  }

  let guard;
  try { guard = await createHtmlGuard(); }
  catch (error) { console.error(`guard startup failed: ${error.message}`); return 1; }
  try {
    const files = input === "-" ? ["-"] : isDirectory ? htmlFiles(input) : [input];
    if (files.length === 0) { console.error("no .html or .htm files found"); return 1; }
    let refused = 0;
    for (const file of files) {
      const source = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
      const result = filterHtml(guard, source);
      if (result.status !== "accepted") {
        refused++;
        console.error(`${file}: refused ${JSON.stringify(result.reason)}`);
        continue;
      }
      if (isDirectory) {
        const target = resolve(args.outDir, relative(input, file));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, result.html);
        console.error(`${file}: accepted -> ${target}`);
      } else if (args.out) {
        writeFileSync(resolve(args.out), result.html);
        console.error(`${file}: accepted -> ${args.out}`);
      } else {
        process.stdout.write(result.html);
      }
    }
    return refused ? 1 : 0;
  } finally {
    guard.checker.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
