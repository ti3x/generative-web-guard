# Lean 4 checker

Executable specification of the HTML/SVG policy, with proofs. Built and run
only inside Docker; nothing is installed on the host. The JavaScript checker in
`../src/policy.js` must agree with it on every input (see `npm run check:lean`).

## Layout

```
lakefile.toml          lib Guard (checker), lib Tests, exe guard (stdin/stdout), exe guard-tests
lean-toolchain         v4.15.0: the last release with a prebuilt wasm32 runtime (see PLAN.md "Moving off the pin")
Dockerfile             stages: toolchain, build, checker, test, wasm-tools, wasm
Guard.lean             umbrella import of every Guard.* module (Lake and the Wasm link depend on it)
Main.lean              batch executable: one JSON request in, one JSON response out
Guard/
  Rules.lean           GENERATED from ../rules/catalog.json by scripts/gen-rules.mjs. Do not edit.
  Core/                Chars, ListUtil, generated Limits, Json, Tree (total equality and conversion to Raw)
  Validators/          Number, Text, Ident, Color, Path, Transform. All total; no `partial`.
  Policy/              Val, generated Tables/{Html,Svg,Attrs}, total Check, Accept (output predicate)
  Props/               Proofs, one file per validator family, plus Checker (IsValidated)
  Io/Api.lean          processRequest (pure) and the @[export guard_check] symbol for Wasm
Tests/                 #guard unit checks (Validators, Tables) and the guard-tests executable
wasm/                  Emscripten shim and build script
```

## Conventions

- One concept per file. Every `Validators/X.lean` has a `Props/X.lean`.
- Policy traversal is total, with explicit decreasing fuel. JSON adapters remain
  outside the proof boundary and use `partial` definitions.
- Every table entry that removes or rewrites something carries a rule id from
  `Guard.R` (generated). `Change.rule` is compared by the differential, so the
  JavaScript tables must cite the same ids for the same cases.
- No `sorry`. `grep -rn sorry Guard Tests` must be empty.
- Existing namespaces: `Guard` (tree, tables, checker), `Guard.V` (validators),
  `Guard.Props` (proofs), `Guard.J` (JSON), `Guard.R` (rule ids).

## Commands (from the repository root)

```
docker build --target toolchain -t guard-lean-toolchain lean/      # once
docker run --rm -v "$PWD/lean:/guard" guard-lean-toolchain lake build           # library + guard exe
npm run lean:test                                                    # #guard checks + guard-tests
npm run check:lean                                                   # differential vs policy.js
npm run check:proofs                                                 # theorem-kind and transitive-axiom audit
npm test                                                            # rebuild native + Wasm and require all engines
npm run wasm:build && npm run check:wasm                             # Emscripten build + Wasm differential
```

`lake test` is not used: the Lake shipped with 4.15 does not accept the
`testDriver` key, so `npm run lean:test` builds the `Tests` library and runs
`lake exe guard-tests` directly.

## Regenerating rule ids

Edit `../rules/catalog.json`, then `npm run gen:rules`. `npm test` fails if
`Guard/Rules.lean` or `../src/rules.js` is stale.

Edit `../rules/policy.json`, then `npm run gen:policy`, for allowlists, attribute
validator selections, forced values, and limits. Do not edit generated tables.
Validator algorithms remain separate implementations; their descriptors are
shared data. See [the maintenance guide](../docs/VERIFICATION.md).

`Props/Checker.lean` proves accepted-output properties using the explicit
`Policy/Accept.lean` predicate and canonical recheck. The underlying normalizer
is total but is not independently proved always to meet those postconditions.
Kernel checking of source proofs is not a proof of the Wasm compiler or the JS
implementation. Runtime differential tests cover those boundaries empirically.
