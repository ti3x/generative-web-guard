// QuickJS execution core. Runs the generated interaction program inside a
// QuickJS runtime compiled to WebAssembly with memory, stack and time limits.
// Nothing is exposed to the program except the ECMAScript standard library
// that QuickJS ships with. No host functions are injected. State crosses the
// boundary only as JSON text; the view crosses only as a string that the
// host will parse and validate before anything is rendered.
//
// This module is environment-neutral: pass it a loaded QuickJS module
// (browser worker or Node test) and it does the rest.

import { shouldInterruptAfterDeadline } from "quickjs-emscripten-core";

export const DEFAULT_LIMITS = Object.freeze({
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  loadMs: 500,
  stepMs: 200,
  maxViewChars: 400000,
  maxStateChars: 1000000,
  maxSourceChars: 200000,
  maxDataChars: 4 * 1024 * 1024,
  dataMs: 2000,
});

// Evaluated before the program so that later reassignment of JSON or String
// by generated code cannot change how results leave the runtime.
const PRELUDE = `
Object.defineProperty(globalThis, "__host", {
  value: Object.freeze({ parse: JSON.parse, stringify: JSON.stringify, str: String }),
  writable: false, configurable: false, enumerable: false,
});
`;

// Host-supplied data. The host holds the dataset and injects it here as JSON,
// so the model never has to reproduce rows in its own output. The value is
// deep-frozen and bound to a non-writable, non-configurable global named
// data before the program is evaluated. When no data is supplied the global
// is null so data is always defined for the program.
function dataPrelude(dataJson) {
  const literal = dataJson === null ? "null" : `__host.parse(${JSON.stringify(dataJson)})`;
  return `
(function () {
  var d = ${literal};
  (function freeze(o) {
    if (o === null || typeof o !== "object" || Object.isFrozen(o)) return;
    Object.freeze(o);
    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) freeze(o[keys[i]]);
  })(d);
  Object.defineProperty(globalThis, "data", { value: d, writable: false, configurable: false, enumerable: true });
})()
`;
}

const INTERFACE_CHECK = `
(function () {
  if (typeof update !== "function") throw new Error("update must be a function");
  if (typeof view !== "function") throw new Error("view must be a function");
  if (typeof initialState === "undefined") throw new Error("initialState is required");
  return "ok";
})()
`;

export function createCore(QuickJS, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  let runtime = null;
  let context = null;
  let loaded = false;

  function evalWithDeadline(code, ms) {
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ms));
    let result;
    try {
      result = context.evalCode(code, "program.js", { type: "global", strict: false });
    } finally {
      runtime.removeInterruptHandler();
    }
    if (result.error) {
      const err = context.dump(result.error);
      result.error.dispose();
      const message = err && typeof err === "object" ? `${err.name}: ${err.message}` : String(err);
      throw new Error(message);
    }
    const value = context.dump(result.value);
    result.value.dispose();
    return value;
  }

  function fresh() {
    dispose();
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(L.memoryBytes);
    runtime.setMaxStackSize(L.stackBytes);
    context = runtime.newContext();
  }

  function dispose() {
    if (context) { context.dispose(); context = null; }
    if (runtime) { runtime.dispose(); runtime = null; }
    loaded = false;
  }

  // Runs update then view inside the runtime. Input and output are JSON text
  // built with the host's own JSON.stringify so program text and data never
  // mix: the data is embedded as a string literal and parsed inside.
  function run(stateJson, eventJson) {
    const code = `
(function () {
  var h = __host;
  var s0 = h.parse(${JSON.stringify(stateJson)});
  var ev = ${eventJson === null ? "null" : `h.parse(${JSON.stringify(eventJson)})`};
  var s1 = ev === null ? s0 : update(s0, ev);
  var out = h.stringify(s1);
  if (typeof out !== "string") throw new Error("state is not JSON-serializable");
  if (out.length > ${L.maxStateChars}) throw new Error("state too large");
  var v = view(h.parse(out));
  if (typeof v !== "string") throw new Error("view must return a string");
  if (v.length > ${L.maxViewChars}) throw new Error("view too large");
  return h.stringify([out, v]);
})()
`;
    const packed = evalWithDeadline(code, L.stepMs);
    if (typeof packed !== "string") throw new Error("runtime returned a non-string");
    const [state, view] = JSON.parse(packed);
    if (typeof state !== "string" || typeof view !== "string") throw new Error("malformed runtime result");
    return { state, view };
  }

  return {
    // dataJson: optional JSON text from the host, exposed to the program as a
    // frozen global named data. Pass null for none.
    load(source, dataJson = null) {
      if (typeof source !== "string" || source.length > L.maxSourceChars) {
        throw new Error("source missing or too large");
      }
      if (dataJson !== null && (typeof dataJson !== "string" || dataJson.length > L.maxDataChars)) {
        throw new Error("data must be JSON text within the size limit");
      }
      fresh();
      evalWithDeadline(PRELUDE, L.loadMs);
      evalWithDeadline(dataPrelude(dataJson), L.dataMs);
      evalWithDeadline(source, L.loadMs);
      evalWithDeadline(INTERFACE_CHECK, L.loadMs);
      loaded = true;
    },
    // Initial state and first view. Returns { state: json, view: string }.
    init() {
      if (!loaded) throw new Error("no program loaded");
      const initial = evalWithDeadline("__host.stringify(initialState)", L.stepMs);
      if (typeof initial !== "string") throw new Error("initialState is not JSON-serializable");
      return run(initial, null);
    },
    step(stateJson, eventJson) {
      if (!loaded) throw new Error("no program loaded");
      return run(stateJson, eventJson);
    },
    dispose,
    get limits() {
      return L;
    },
  };
}
