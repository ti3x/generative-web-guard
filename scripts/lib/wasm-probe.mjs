import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLeanChecker } from "../../src/lean-checker.js";
import { DEFAULT_CLASSES } from "./engines.mjs";

// Test/measurement adapter over the very same factory passed to production
// glue. Capturing its module here does not add an inspection API to production.
export async function wasmProbe(classes = DEFAULT_CLASSES) {
  const createModule = (await import("../../lean/wasm/dist/guard.mjs")).default;
  let module;
  const checker = await createLeanChecker({ createModule: async config => (module = await createModule(config)),
    wasmBinary: new Uint8Array(readFileSync(new URL("../../lean/wasm/dist/guard.wasm", import.meta.url))),
    classes, stylesheetHash: "phase7" });
  const bind = (name, ret = "number", args = []) => module.cwrap(name, ret, args);
  const heapBreak = bind("guard_heap_break"), input = bind("guard_input_buffer")();
  const capacity = bind("guard_input_capacity")(), check = bind("guard_check", "number", ["number"]);
  const ptr = bind("guard_response_ptr"), len = bind("guard_response_len"), release = bind("guard_response_release", null);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    checker, capacity,
    measure: () => ({ heapBreak: heapBreak(), memoryBytes: module.HEAPU8.length }),
    raw(bytes, length = bytes.length) {
      assert.ok(bytes.length <= capacity, "harness must not overflow staging buffer");
      module.HEAPU8.set(bytes, input);
      try {
        const status = check(length), size = len();
        if (status !== 0) { assert.equal(size, 0, "shim failure retained a stale response"); return { status, response: null }; }
        assert.ok(size > 0 && size <= 8_000_000, "unbounded or absent response");
        return { status, response: JSON.parse(decoder.decode(module.HEAPU8.subarray(ptr(), ptr() + size))) };
      } finally { release(); }
    },
    close() { checker.dispose(); },
  };
}
