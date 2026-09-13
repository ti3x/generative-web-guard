// QuickJS execution core. Runs the generated interaction program inside a
// QuickJS runtime compiled to WebAssembly with memory, stack and time limits.
// Nothing is exposed to the program except the ECMAScript standard library
// that QuickJS ships with. No host functions are injected. State crosses the
// boundary only as JSON text; the view crosses only as a string that the
// host will parse and validate before anything is rendered.
//
// Two rules decide how results leave the runtime, and both live on the host
// side of the boundary:
//
//   1. Output bounds are the host's. The program is asked for a value of a
//      known shape and the host inspects that value's type and length through
//      the FFI before it copies anything out. It never hands a guest object to
//      a generic dump, and it never lets guest code decide how long a copy is.
//      A guest-side length check would be advisory at best: any serialization
//      hook or prototype mutation runs after it.
//   2. The evaluation deadline stays installed until extraction and error
//      reporting have finished. Reading an array element or an error's message
//      can run guest code, so removing the interrupt handler first would leave
//      that code with no time bound at all.
//
// Limits and packet shape come from ./protocol.js, which the worker and the
// controller share, so no side keeps its own copy of a bound.
//
// This module is environment-neutral: pass it a loaded QuickJS module
// (browser worker or Node test) and it does the rest.

import { shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import { DEFAULT_LIMITS, loadProgramLimit, resolveLimits, stepProgramLimit } from "./protocol.js";

export { DEFAULT_LIMITS };

// Evaluated before the program so that later reassignment of JSON or String
// by generated code cannot change how results leave the runtime. __host is
// non-writable and frozen, and every member is captured from a pristine
// global before any generated code has run.
//
// __host.detail produces the host's error diagnostics inside the guest. The
// host calls it with the thrown value rather than coercing that value itself,
// so a hostile toString, valueOf or Symbol.toPrimitive never decides what the
// host allocates or reports. It returns "" for anything it cannot read as a
// short string, and the host then reports a generic failure. Note what it
// does not do: it calls no method on a guest string, because String.prototype
// is guest-writable. It uses only the non-configurable own "length" property
// of a string and the string "+" operator on values it has already checked
// with typeof.
function prelude(maxDiagnosticChars) {
  return `
Object.defineProperty(globalThis, "__host", {
  value: Object.freeze({
    parse: JSON.parse,
    stringify: JSON.stringify,
    str: String,
    detail: function (e) {
      try {
        var t = typeof e;
        if (t === "string") return e.length > ${maxDiagnosticChars} ? "" : e;
        if (e === null || (t !== "object" && t !== "function")) return "";
        var m = e.message;
        if (typeof m !== "string" || m.length > ${maxDiagnosticChars}) return "";
        var n = e.name;
        if (typeof n !== "string" || n.length > 200) n = "Error";
        return n + ": " + m;
      } catch (ignored) {
        return "";
      }
    },
  }),
  writable: false, configurable: false, enumerable: false,
});
`;
}

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
  const L = resolveLimits(limits);
  const maxLoadProgramChars = loadProgramLimit(L);
  const maxStepProgramChars = stepProgramLimit(L);
  let runtime = null;
  let context = null;
  let loaded = false;
  let interrupted = false;

  // Installs the deadline, runs fn, and only then removes the handler. fn
  // covers evaluation *and* extraction: see rule 2 in the header comment.
  // The wrapper also records whether the deadline actually fired, so a
  // timeout is reported from host state instead of from a guest error object
  // whose properties would have to be read after the budget is gone.
  function withDeadline(ms, fn) {
    const stop = shouldInterruptAfterDeadline(Date.now() + ms);
    interrupted = false;
    runtime.setInterruptHandler((rt) => {
      const halt = stop(rt);
      if (halt) interrupted = true;
      return halt;
    });
    try {
      return fn();
    } finally {
      runtime.removeInterruptHandler();
    }
  }

  // Typed, length-checked extraction of a guest string. Nothing is copied out
  // until the value is known to be a string and known to be short enough.
  //
  // Reading "length" cannot run guest code: on a string it is a
  // non-configurable own property of the string itself, so a rewritten
  // String.prototype does not shadow it (verified against
  // quickjs-emscripten 0.31). On an array element read the own index property
  // wins over any prototype accessor for the same reason.
  //
  // Unavoidable copy bound, recorded rather than papered over: getString()
  // converts the whole guest string in one FFI call and the FFI offers no
  // partial, truncating or streaming read. The checked UTF-16 length is
  // therefore the only bound available, and because the conversion goes
  // through UTF-8 the transient buffer can reach three bytes per checked code
  // unit. maxStateChars, maxViewChars and maxDiagnosticChars cap that
  // allocation; nothing larger is ever copied.
  function readString(handle, max, label) {
    const type = context.typeof(handle);
    if (type !== "string") throw new Error(`${label} must be a string, got ${type}`);
    const length = readLength(handle, label);
    if (length > max) throw new Error(`${label} too large: ${length} > ${max}`);
    return context.getString(handle);
  }

  function readLength(handle, label) {
    const lengthHandle = context.getProp(handle, "length");
    try {
      if (context.typeof(lengthHandle) !== "number") throw new Error(`${label} has no numeric length`);
      const length = context.getNumber(lengthHandle);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${label} has an invalid length`);
      return length;
    } finally {
      lengthHandle.dispose();
    }
  }

  // Successful results are extracted field by field from a known shape: the
  // step program returns exactly [stateJson, view] and nothing else is
  // accepted. There is no generic dump of a guest object anywhere on this
  // path, so a getter, a Proxy trap or a prototype toJSON cannot choose what
  // the host copies out, and a third element cannot smuggle a field past the
  // shape check.
  function readPacket(handle) {
    const type = context.typeof(handle);
    if (type !== "object") throw new Error(`runtime result must be an array, got ${type}`);
    const length = readLength(handle, "runtime result");
    if (length !== 2) throw new Error(`runtime result must have exactly 2 fields, got ${length}`);
    return {
      state: readIndex(handle, 0, L.maxStateChars, "state"),
      view: readIndex(handle, 1, L.maxViewChars, "view"),
    };
  }

  function readIndex(handle, index, max, label) {
    const item = context.getProp(handle, index);
    try {
      return readString(item, max, label);
    } finally {
      item.dispose();
    }
  }

  // Calls the prelude's bounded extractor with the thrown value. This runs
  // under the still-installed deadline, and its result is type- and
  // length-checked like any other guest string. Any failure yields "" and the
  // caller reports a generic error rather than guessing.
  function guestDetail(errorHandle) {
    let host = null;
    let detail = null;
    let value = null;
    try {
      host = context.getProp(context.global, "__host");
      if (context.typeof(host) !== "object") return "";
      detail = context.getProp(host, "detail");
      if (context.typeof(detail) !== "function") return "";
      const called = context.callFunction(detail, context.undefined, errorHandle);
      if (called.error) {
        called.error.dispose();
        return "";
      }
      value = called.value;
      return readString(value, L.maxDiagnosticChars, "diagnostic");
    } catch (ignored) {
      return "";
    } finally {
      // context.global is owned by the context and must not be disposed.
      for (const handle of [value, detail, host]) if (handle) handle.dispose();
    }
  }

  // Evaluates code under a deadline and extracts its result with extract.
  // Handles are disposed on every path, including when extraction itself
  // throws.
  function evalGuest(code, ms, extract) {
    return withDeadline(ms, () => {
      const result = context.evalCode(code, "program.js", { type: "global", strict: false });
      if (result.error) {
        let detail = "";
        try {
          if (!interrupted) detail = guestDetail(result.error);
        } catch (ignored) {
          detail = "";
        } finally {
          result.error.dispose();
        }
        // interrupted is re-read here: the deadline can fire inside
        // guestDetail, which is exactly the hostile-getter case.
        if (interrupted) throw new Error(`interrupted: guest execution exceeded ${ms}ms`);
        throw new Error(detail || "guest execution failed");
      }
      try {
        return extract(result.value);
      } finally {
        result.value.dispose();
      }
    });
  }

  // Used where the result is irrelevant: the preludes, the program source
  // itself and the interface check. Copying the value of the program's last
  // expression out of the guest would be a generic dump of an attacker-chosen
  // object for no benefit, so nothing is copied at all.
  function discard() {
    return undefined;
  }

  // State text is re-embedded in the next step's program, so the host checks
  // that it really is JSON rather than merely a short string. The parse is
  // bounded by the length check that preceded it, and a nesting depth that
  // would exhaust the host parser surfaces as a RangeError here instead of
  // one step later inside the guest.
  function checkJsonText(text, label) {
    try {
      JSON.parse(text);
    } catch (ignored) {
      // The host parser's own message can quote the offending input, so only
      // the label is reported.
      throw new Error(`${label} is not JSON text`);
    }
    return text;
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
  //
  // The program returns [stateJson, view] as an array literal. The guest
  // keeps the two typeof checks below because they name the interface mistake
  // precisely and cost nothing; the lengths are not checked here, because a
  // check inside the guest is not a bound. readPacket enforces those.
  function run(stateJson, eventJson) {
    if (typeof stateJson !== "string") throw new Error("state must be JSON text");
    if (stateJson.length > L.maxStateChars) {
      throw new Error(`state too large: ${stateJson.length} > ${L.maxStateChars}`);
    }
    if (eventJson !== null && typeof eventJson !== "string") throw new Error("event must be JSON text or null");
    if (eventJson !== null && eventJson.length > L.maxEventChars) {
      throw new Error(`event too large: ${eventJson.length} > ${L.maxEventChars}`);
    }
    const code = `
(function () {
  var h = __host;
  var s0 = h.parse(${JSON.stringify(stateJson)});
  var ev = ${eventJson === null ? "null" : `h.parse(${JSON.stringify(eventJson)})`};
  var s1 = ev === null ? s0 : update(s0, ev);
  var out = h.stringify(s1);
  if (typeof out !== "string") throw new Error("state is not JSON-serializable");
  var v = view(h.parse(out));
  if (typeof v !== "string") throw new Error("view must return a string");
  return [out, v];
})()
`;
    // Asserts the escaping arithmetic in protocol.js: the inputs were just
    // bounded, so this can only fire if that derivation is wrong.
    if (code.length > maxStepProgramChars) {
      throw new Error(`step program too large: ${code.length} > ${maxStepProgramChars}`);
    }
    const packet = evalGuest(code, L.stepMs, readPacket);
    checkJsonText(packet.state, "state");
    return packet;
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
      evalGuest(prelude(L.maxDiagnosticChars), L.loadMs, discard);
      const dataCode = dataPrelude(dataJson);
      if (dataCode.length > maxLoadProgramChars) {
        throw new Error(`data program too large: ${dataCode.length} > ${maxLoadProgramChars}`);
      }
      evalGuest(dataCode, L.dataMs, discard);
      evalGuest(source, L.loadMs, discard);
      evalGuest(INTERFACE_CHECK, L.loadMs, discard);
      loaded = true;
    },
    // Initial state and first view. Returns { state: json, view: string }.
    init() {
      if (!loaded) throw new Error("no program loaded");
      const initial = evalGuest("__host.stringify(initialState)", L.stepMs, (handle) => {
        if (context.typeof(handle) !== "string") throw new Error("initialState is not JSON-serializable");
        return readString(handle, L.maxStateChars, "initialState");
      });
      checkJsonText(initial, "initialState");
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
