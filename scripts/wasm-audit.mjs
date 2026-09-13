// Measure the Lean/Wasm checker's memory and stack use, so the ceilings in
// lean/wasm/build.sh are derived from evidence instead of inherited.
//
//   node scripts/wasm-audit.mjs
//
// WHAT IT MEASURES
//
//   heap break     `sbrk(0)` after instantiation and after each worst case.
//                  This is the high-water mark of allocator-reserved memory.
//   memory size    `HEAPU8.length`, which grows if INITIAL_MEMORY is too
//                  small. A growth event during a hostile document means the
//                  document pays for a copy of the whole heap.
//   stack use      the unused stack region is painted with a pattern before a
//                  call and scanned afterwards for the deepest modified byte.
//                  That is the stack high-water mark for that call, and it
//                  needs no instrumented rebuild.
//
// WHAT IT DOES NOT ESTABLISH
//
// Lean's termination proofs bound the number of steps for a given input; they
// say nothing about bytes or wall-clock time. These are measurements of this
// build on these inputs, not a proof of a bound for every input. The ceilings
// exist so that an input outside what was measured fails cleanly instead of
// growing without limit.
//
// The worst cases below are the largest documents the frontend will forward:
// the decoder's bounds are the preprocessing bounds, so nothing larger than
// these can reach the checker through the policy Worker.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { configureRequest, checkRequest, readCheckResponse, readInfoResponse } from "../src/lean-abi.js";
import { PREPROCESS_LIMITS } from "../src/policy-protocol.js";

const WASM_MJS = new URL("../lean/wasm/dist/guard.mjs", import.meta.url);
const WASM_BIN = new URL("../lean/wasm/dist/guard.wasm", import.meta.url);
const PAINT = 0xa5;

const createGuardChecker = (await import(pathToFileURL(WASM_MJS.pathname).href)).default;
const Module = await createGuardChecker({ wasmBinary: readFileSync(WASM_BIN) });

const fn = (name, ret, args) => Module.cwrap(name, ret, args);
const api = {
  init: fn("guard_init", "number", []),
  info: fn("guard_info", "number", []),
  configure: fn("guard_configure_seal", "number", ["number"]),
  check: fn("guard_check", "number", ["number"]),
  inputBuffer: fn("guard_input_buffer", "number", []),
  inputCapacity: fn("guard_input_capacity", "number", []),
  responsePtr: fn("guard_response_ptr", "number", []),
  responseLen: fn("guard_response_len", "number", []),
  release: fn("guard_response_release", null, []),
  stackBase: fn("guard_stack_base", "number", []),
  stackEnd: fn("guard_stack_end", "number", []),
  stackCurrent: fn("guard_stack_current", "number", []),
  heapBreak: fn("guard_heap_break", "number", []),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const inputPtr = api.inputBuffer();

function call(fnToCall, text) {
  const bytes = encoder.encode(text);
  Module.HEAPU8.set(bytes, inputPtr);
  const status = fnToCall(bytes.length);
  if (status !== 0) return { status, text: "" };
  const ptr = api.responsePtr();
  const len = api.responseLen();
  const out = decoder.decode(Module.HEAPU8.subarray(ptr, ptr + len));
  api.release();
  return { status, text: out };
}

const mib = (n) => (n / 1024 / 1024).toFixed(2);

if (api.init() !== 0) throw new Error("lean runtime failed to initialize");

const stackBase = api.stackBase();
const stackEnd = api.stackEnd();
const stackSize = stackBase - stackEnd;
const afterInitBreak = api.heapBreak();
const afterInitMemory = Module.HEAPU8.length;

console.log(`stack region: ${stackEnd}..${stackBase} (${mib(stackSize)} MiB)`);
console.log(`after init:   heap break ${mib(afterInitBreak)} MiB, memory ${mib(afterInitMemory)} MiB`);

const info = readInfoResponse(call(api.info).text, "info");
if (!info.ok) throw new Error(`guard_info refused: ${JSON.stringify(info.reason)}`);
console.log(`module:       ${info.checker.checkerVersion}, capability v${info.checker.capabilityVersion}, profile ${info.checker.profile}`);
console.log(`input buffer: ${api.inputCapacity()} bytes (frontend candidate limit ${PREPROCESS_LIMITS.maxCandidateUtf8Bytes})`);

const cfg = configureRequest({ classes: ["card", "muted", "bar"], stylesheetHash: "audit" });
const cfgResult = call(api.configure, cfg);
if (cfgResult.status !== 0) throw new Error(`configure failed with status ${cfgResult.status}`);

// ---------------------------------------------------------------------------
// Worst legal documents. Each is at a preprocessing bound, so nothing bigger
// can arrive through the policy Worker.
// ---------------------------------------------------------------------------
const el = (children, attrs = []) => ({ kind: "el", ns: "html", tag: "div", attrs, children });
const text = (s) => ({ kind: "text", text: s });

function nest(depth) {
  let node = el([text("x")]);
  for (let i = 1; i < depth; i++) node = el([node]);
  return { kind: "root", children: [node] };
}
function wide(count) {
  return { kind: "root", children: Array.from({ length: count }, () => el([text("x")], [["class", "card"]])) };
}
function manyAttrs(count) {
  const attrs = Array.from({ length: count }, (_, i) => [`data-x${i}`, "1"]);
  return { kind: "root", children: [el([text("x")], attrs)] };
}
function bigText(chars) {
  return { kind: "root", children: [el([text("y".repeat(chars))])] };
}
function texts(count) {
  return { kind: "root", children: Array.from({ length: count }, () => text("x")) };
}
// Wide and shallow: the most nodes the frontend forwards (maxRawNodes) with
// few open at once, which is the shape maxRawPathNodes lets through.
function grouped(total, width = 50) {
  const groups = Math.ceil(total / width);
  return { kind: "root", children: Array.from({ length: groups }, () => el(Array.from({ length: width - 1 }, () => text("x")))) };
}
// The largest candidate the frontend will forward. Three bounds interact:
// maxRawNodes caps the node count, maxRawTotalTextCodeUnits caps the text, and
// maxCandidateUtf8Bytes caps the transport. This builds the largest document
// that satisfies all three.
function bigCandidate() {
  const chunk = "z".repeat(4000);
  const perChild = 2; // an element plus its text node
  const byNodes = Math.floor(PREPROCESS_LIMITS.maxRawNodes / perChild);
  const byText = Math.floor(PREPROCESS_LIMITS.maxRawTotalTextCodeUnits / chunk.length);
  const count = Math.min(byNodes, byText);
  return { kind: "root", children: Array.from({ length: count }, () => el([text(chunk)], [["class", "card"]])) };
}

const cases = [
  ["typical document", { kind: "root", children: [el([text("Quarterly revenue")], [["class", "card"]])] }],
  [`nesting at maxRawDepth (${PREPROCESS_LIMITS.maxRawDepth})`, nest(PREPROCESS_LIMITS.maxRawDepth)],
  [`nesting past maxRawDepth`, nest(PREPROCESS_LIMITS.maxRawDepth + 8)],
  [`${PREPROCESS_LIMITS.maxRawPathNodes / 2} elements with text (maxRawPathNodes)`, wide(PREPROCESS_LIMITS.maxRawPathNodes / 2)],
  [`${PREPROCESS_LIMITS.maxRawNodes} nodes in groups of 50 (maxRawNodes)`, grouped(PREPROCESS_LIMITS.maxRawNodes)],
  [`${PREPROCESS_LIMITS.maxRawPathNodes} sibling text nodes (maxRawPathNodes)`, texts(PREPROCESS_LIMITS.maxRawPathNodes)],
  [`${PREPROCESS_LIMITS.maxRawPathNodes + 1} sibling text nodes (past maxRawPathNodes)`, texts(PREPROCESS_LIMITS.maxRawPathNodes + 1)],
  [`${PREPROCESS_LIMITS.maxRawAttrsPerElement} attributes on one element`, manyAttrs(PREPROCESS_LIMITS.maxRawAttrsPerElement)],
  [`one text node of ${PREPROCESS_LIMITS.maxRawTextCodeUnits} code units`, bigText(PREPROCESS_LIMITS.maxRawTextCodeUnits)],
  ["largest document all three input bounds allow", bigCandidate()],
];

let peakBreak = afterInitBreak;
let peakMemory = afterInitMemory;
let deepestStack = 0;
const rows = [];

for (const [label, document] of cases) {
  const request = checkRequest("audit", document);
  const requestBytes = encoder.encode(request).length;
  if (requestBytes > api.inputCapacity()) {
    rows.push([label, "SKIPPED: larger than the input buffer", "", "", ""]);
    continue;
  }
  // Paint the unused stack region, then measure how deep the call went.
  const current = api.stackCurrent();
  Module.HEAPU8.fill(PAINT, stackEnd, current);
  const t0 = performance.now();
  let status = 0;
  let out = "";
  try {
    ({ status, text: out } = call(api.check, request));
  } catch (error) {
    // A host call-stack overflow inside the module surfaces here as a
    // RangeError. It is a genuine finding, not a harness bug: the wasm call
    // stack is the engine's and is NOT what -sSTACK_SIZE configures.
    rows.push([label, `THREW ${String(error && error.message).slice(0, 60)}`, `${requestBytes}`, "", ""]);
    continue;
  }
  const ms = performance.now() - t0;
  let low = stackEnd;
  const heap = Module.HEAPU8;
  while (low < current && heap[low] === PAINT) low++;
  const used = current - low;
  if (used > deepestStack) deepestStack = used;
  const brk = api.heapBreak();
  if (brk > peakBreak) peakBreak = brk;
  if (Module.HEAPU8.length > peakMemory) peakMemory = Module.HEAPU8.length;
  const verdict = status !== 0 ? `shim status ${status}` : readCheckResponse(out, "audit").status;
  rows.push([label, verdict, `${requestBytes}`, `${ms.toFixed(0)} ms`, `stack ${used} bytes, break ${mib(brk)} MiB, memory ${mib(Module.HEAPU8.length)} MiB`]);
}

console.log("");
for (const [label, verdict, bytes, ms, mem] of rows) {
  console.log(`  ${label}\n    -> ${verdict}${bytes ? `, request ${bytes} bytes, ${ms}` : ""}\n       ${mem}`);
}

console.log("");
console.log(`PEAK heap break:      ${mib(peakBreak)} MiB`);
console.log(`PEAK memory size:     ${mib(peakMemory)} MiB (INITIAL_MEMORY is ${mib(afterInitMemory)} MiB)`);
console.log(`PEAK stack use:       ${deepestStack} bytes (${mib(deepestStack)} MiB) of ${mib(stackSize)} MiB configured`);
console.log(`memory growth events: ${peakMemory > afterInitMemory ? "YES -- INITIAL_MEMORY is below the worst legal document" : "none"}`);
