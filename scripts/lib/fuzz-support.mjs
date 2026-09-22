import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
export { rng } from "../lean-differential.mjs";

export function options(defaults = {}, extra = {}) {
  const { values } = parseArgs({ options: {
    seed: { type: "string", default: "1" }, iterations: { type: "string", default: "250" },
    minutes: { type: "string", default: "0" }, replay: { type: "string" }, report: { type: "string" },
    ...extra,
  } });
  const out = { ...defaults, ...values };
  for (const key of ["seed", "iterations", "minutes"]) {
    out[key] = Number(out[key]);
    if (!Number.isFinite(out[key]) || out[key] < 0 || (key !== "minutes" && !Number.isSafeInteger(out[key]))) throw new Error(`invalid --${key}`);
  }
  if (out.seed > 0xffffffff || out.iterations < 1) throw new Error("seed must fit uint32; iterations must be positive");
  return out;
}

export const hash = value => createHash("sha256").update(value).digest("hex");
export function provenance(harness) {
  return {
    harness, harnessVersion: 1, node: process.version,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length > 0,
    checkerSha256: existsSync("lean/wasm/dist/guard.wasm") ? hash(readFileSync("lean/wasm/dist/guard.wasm")) : null,
  };
}
export function report(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export function readReplay(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function failure(path, metadata, input, error) {
  const value = { ...metadata, status: "failed", input, error: String(error.stack ?? error) };
  report(path, value);
  return value;
}

// The watchdog runs outside the synchronous parser/Wasm/QuickJS execution.
// One worker per campaign preserves repeated-instance behavior. A timeout or
// crash ends that campaign; it is never quietly retried with a fresh instance.
export async function supervised(url, workerData = {}, startupMs = 20000) {
  const worker = new Worker(url, { workerData, execArgv: [] });
  let pending = null, nextId = 0, dead = false;
  const exit = reason => {
    dead = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(reason); pending = null; }
  };
  worker.on("error", exit);
  worker.on("exit", code => exit(new Error(`harness worker exited (${code})`)));
  worker.on("message", message => {
    if (!pending || message.id !== pending.id) return;
    const job = pending; pending = null; clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error)); else job.resolve(message.value);
  });
  const run = (input, timeoutMs) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error("harness worker is dead"));
    if (pending) return reject(new Error("concurrent harness request"));
    const id = ++nextId;
    const timer = setTimeout(() => { exit(new Error(`external watchdog exceeded ${timeoutMs}ms`)); void worker.terminate(); }, timeoutMs);
    pending = { id, resolve, reject, timer };
    worker.postMessage({ id, input });
  });
  let info;
  try { info = await run({ op: "ready" }, startupMs); }
  catch (error) { await worker.terminate(); throw error; }
  return { info, run, async close() { exit(new Error("harness closed")); await worker.terminate(); } };
}

// Chunk reduction preserves the exact failure oracle, not just any exception.
// Callers save the original before starting this bounded best-effort reduction.
export async function reduceSequence(sequence, reproduces, maxAttempts = 100) {
  let result = sequence.slice(), attempts = 0;
  for (let width = Math.floor(result.length / 2); width >= 1; width = Math.floor(width / 2)) {
    for (let start = 0; start + width <= result.length && attempts < maxAttempts;) {
      const candidate = [...result.slice(0, start), ...result.slice(start + width)];
      attempts++;
      if (await reproduces(candidate)) result = candidate; else start += width;
    }
  }
  return { sequence: result, attempts };
}
