# QuickJS calculation runtime

Calculation is ordinary JavaScript in `update` and `view`. It runs unmodified
in QuickJS with the language and standard library: numbers, BigInt, Math,
strings, regular expressions, arrays, Map and Set, Date, JSON, closures,
classes, and recursion. The restrictions are about reach, not computation:
`fetch`, timers, DOM, storage, and imports are absent from the runtime rather
than blocked. The optional linter can report them before execution, but it is a
diagnostic; confinement does not depend on it.

The defaults are a 200 ms interrupt budget per step, 32 MiB memory, a 512 KiB
stack, and a 400,000-character view. They are configurable in
`src/runtime/core.js`.

## Host-supplied data

The host keeps the dataset and passes it to `runtime.load(source, data)`. It is
serialized once, injected into QuickJS as a deep-frozen global named `data`
before the program runs, and never appears in model output. Generated code can
read `data`, and the host can label displayed numbers as coming from the real
source. Without host data, the global is `null`. The default size limit is
4 MiB.

## Programming constraints

- Every event value is a string. Convert and validate it, and fall back on bad
  input rather than rendering `NaN`.
- State must survive JSON serialization. Dates become strings, Map and Set
  disappear, and functions cannot be stored. Recompute derived values in
  `view` instead of storing them.
- QuickJS has no `Intl` locale data, so numbers and dates need explicit
  formatting.
- `update` and `view` are pure, allowing the host to replay an event sequence
  without a browser for debugging and tests.
- If a step exceeds a budget, execution is interrupted, the runtime is marked
  dead, the last accepted view stays visible, and the host receives the
  failure.

Every view produced by this runtime still travels through the independent
policy Worker and Lean/Wasm acceptance boundary before it can reach the frame.
See [verification scope](VERIFICATION.md) for what that boundary does and does
not prove.
