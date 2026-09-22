// Run a generated interaction program through the production QuickJS core,
// then pass its initial HTML view through the Lean/Wasm authority.
//
//   npm run guard:js -- examples/cli/program.js --data examples/cli/data.json
//
// This command deliberately emits HTML, never rewritten JavaScript. It uses
// the same QuickJS core and default limits as the Worker; the browser Worker
// transport itself is not needed for a one-shot command-line evaluation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getQuickJS } from "quickjs-emscripten";
import { createCore } from "../src/runtime/core.js";
import { createHtmlGuard, filterHtml } from "./guard-html.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run guard:js -- PROGRAM.js > FILTERED.html",
    "  npm run guard:js -- PROGRAM.js --data DATA.json > FILTERED.html",
    "  npm run guard:js -- PROGRAM.js --out FILTERED.html",
    "",
    "PROGRAM must define initialState, update(state, event), and view(state).",
    "--data is optional JSON exposed to the program as a frozen global named data.",
    "The command runs the initial view only, then writes Lean/Wasm-accepted HTML.",
  ].join("\n");
}

function parseArgs(argv) {
  let program = null, data = null, out = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--data" || arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a path`);
      if (arg === "--data") data = value;
      else out = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    if (program) throw new Error("only one program path is allowed");
    program = arg;
  }
  if (!program) throw new Error("a program path is required");
  return { program, data, out };
}

function readJsonFile(path) {
  const source = readFileSync(path, "utf8");
  try {
    // Parse and reserialize with the host's JSON implementation. This gives
    // the QuickJS core JSON text, rather than treating an arbitrary file as
    // executable source.
    return JSON.stringify(JSON.parse(source));
  } catch (error) {
    throw new Error(`data file is not valid JSON: ${error.message}`);
  }
}

/** Run the initial program view with the production QuickJS core. */
export async function runInitialView(source, dataJson = null) {
  const QuickJS = await getQuickJS();
  const core = createCore(QuickJS);
  try {
    core.load(source, dataJson);
    return core.init().view;
  } finally {
    core.dispose();
  }
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) { console.error(`${error.message}\n\n${usage()}`); return 2; }
  if (args.help) { console.log(usage()); return 0; }

  const programPath = resolve(args.program);
  const dataPath = args.data && resolve(args.data);
  if (!existsSync(programPath)) { console.error(`program does not exist: ${args.program}`); return 2; }
  if (dataPath && !existsSync(dataPath)) { console.error(`data file does not exist: ${args.data}`); return 2; }

  let checker;
  try {
    const source = readFileSync(programPath, "utf8");
    const dataJson = dataPath ? readJsonFile(dataPath) : null;
    const view = await runInitialView(source, dataJson);
    checker = await createHtmlGuard();
    const result = filterHtml(checker, view);
    if (result.status !== "accepted") {
      console.error(`refused initial view: ${JSON.stringify(result.reason)}`);
      return 1;
    }
    if (args.out) {
      writeFileSync(resolve(args.out), result.html);
      console.error(`${programPath}: accepted initial view -> ${args.out}`);
    } else {
      process.stdout.write(result.html);
    }
    return 0;
  } catch (error) {
    console.error(`guard:js failed: ${error.message}`);
    return 1;
  } finally {
    checker?.checker.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
