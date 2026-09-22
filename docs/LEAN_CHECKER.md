# Lean 4 checker

`lean/` contains the second implementation of the policy in Lean 4. It is
built and run inside Docker, so contributors do not install Lean or Emscripten
on the host. The native executable is a reference/differential engine; the
minimal WebAssembly build is the browser's production acceptance authority.

| Path | Contents |
|---|---|
| `lean/Guard/Rules.lean` | Generated rule ids (`Guard.R`) |
| `lean/Guard/Core/` | Chars, ListUtil, Limits, self-contained JSON, and Tree |
| `lean/Guard/Validators/` | Total Number, Text, Ident, Color, Path, and Transform validators |
| `lean/Guard/Policy/` | Value descriptors, generated policy tables, reference `Check`, and production `Candidate` acceptance |
| `lean/Guard/Props/` | Validator, checker, profile, and candidate-replay proofs |
| `lean/Guard/Io/Abi.lean` | Strict single-document production ABI and `guard_check_document` export |
| `lean/Guard/Io/Decode.lean` | Strict candidate decoder used by the production ABI |
| `lean/Guard/Io/Api.lean` | Permissive batch API for the native differential executable; not exported by Wasm |
| `lean/Guard/Wasm.lean` | Minimal production import root |
| `lean/Tests/` | `#guard` checks and the native `guard-tests` executable |
| `lean/wasm/` | Emscripten shim, import-closure guard, and build script |
| `lean/README.md` | Lean-specific layout, conventions, and commands |

## Toolchain pin

`lean/lean-toolchain` pins Lean `v4.15.0`, the last release that publishes a
prebuilt wasm32 runtime. Later releases would require building Lean's runtime
under Emscripten. The pinned version serves proofs, the native differential,
and the production Wasm build.

## What is proved

Theorems cover validator results and accepted Lean output trees. The full test
command confirms that advertised names are compiled theorems and that their
transitive axioms are limited to Lean's foundational axioms.

- Ids carry the `g-` prefix, and id rewriting is idempotent.
- Canonical number characters are digits, `.` or `-`; number lists additionally
  allow a single space separator.
- Path-data characters are command letters, digits, `.`, `-`, or spaces.
- Transform output is a space-joined list of fixed-table `name(nums)` groups.
- Colors are a permitted named color, `currentColor`, hexadecimal, or accepted
  by the `rgb()` recognizer.

`Guard.Props.Checker` proves whole-reference-checker properties: every accepted
tree satisfies `policyOk`; node and text counts are bounded; nested elements
are allowlisted with canonical attributes; scripts and inline handlers do not
survive; and reference revalidation returns the same tree unchanged.

`Guard.Props.Profile` covers the capability kernel.
`rules/capabilities.json` is a separately reviewed set of closed element and
attribute identities, value grammars, mandatory controls, and absolute limits.
A profile may only restrict it, and `npm run check:policy` rejects a profile
that does not. `default_profile_valid` certifies the shipped profile against
the generated inventory. Independently of the profile table, accepted trees
are proved free of excluded identities such as `src`, `href`, `style`, `name`,
`iframe`, `img`, `form`, and `use`; `fill` and `stroke` are solid colors; and
ids use the `g-` prefix. `restricts_permits` relates profiles on permitted
output trees; it does not claim that a tighter profile accepts fewer raw
inputs. Widening the inventory is a capability-kernel change, and neither the
generator nor an arbitrarily edited inventory is proved safe.

The production checker is `acceptCandidate`: it checks output policy and the
canonical representation, without normalization or replay. The theorem
`candidate_reference_fixed_point` proves that an accepted candidate would pass
the full reference checker unchanged. Profile exclusions, validator
canonicality, node/text bounds, attribute ordering and uniqueness, and output
profile restriction are proved separately.

JavaScript constructs one proposal and its diagnostics; Lean accepts or
refuses that exact proposal. Only Lean's returned tree crosses the private
Worker-to-frame port. Missing, failed, rejected, malformed, or timed-out Lean
never falls back to JavaScript acceptance.

This is not a proof that the JavaScript implementation is equivalent to Lean,
and differential tests are not such a proof. Parsing, JSON conversion, the C
shim, Emscripten, trusted glue, rendering, QuickJS, compilation, and browser
semantics remain outside these theorems. See [verification](VERIFICATION.md)
for the precise boundary.

## Differential testing

```sh
npm run lean:build                    # native checker image
npm run check:lean                    # corpus + random trees through JS and Lean
GUARD_LEAN_MOUNT=1 npm run check:lean # use lean/.lake instead of the image
NEGATIVE_CONTROL=1 npm run check:lean # must find mismatches
```

The differential sends identical parse5 output to both reference checkers and
compares status, tree, changes, and rule ids with object-key order normalized.
The JavaScript validators intentionally mirror Lean's syntactic approach:
number strings are rewritten rather than passed through `Number()`, path data
and transforms use sequential tokenizers, hex-color case is preserved, and
name lowercasing is ASCII-only.

## WebAssembly build

```sh
npm run wasm:build # pinned Emscripten/Lean wasm32 image, then link
npm run check:wasm # load guard.mjs in Node and compare with policy.js
```

The production build starts from `Guard.Wasm`. An import-closure check rejects
reference normalization, the permissive batch API, and proof modules. The
binary is embedded rather than fetched, preserving `connect-src 'none'`. See
[Phase 6 results](phase6-results.md) for startup, memory, latency, message-copy,
distribution-size, and compression measurements.

Four implementation details matter:

- Lean's runtime references four libuv temp-file functions. The wasm32
  distribution has no libuv, so `lean/wasm/shim.c` stubs them; the checker does
  not touch the filesystem.
- `lean_initialize()` plus `libLean` produced a 56 MB module. Initializing only
  the runtime module and linking `libInit` and `libleanrt` reduced it to about
  1.4 MB. This also motivates the self-contained `Guard/Core/Json.lean`.
- The measured linear-memory stack use is 104 bytes for the audit workloads;
  the important recursion uses the engine call stack, which Emscripten's
  `STACK_SIZE` does not configure. The build uses `INITIAL_MEMORY=80MB`,
  `MAXIMUM_MEMORY=128MB`, and `STACK_SIZE=1MB` with overflow checking. Current
  sustained-growth evidence and limitations are recorded in
  [Phase 7 results](phase7-results.md).
- The engine call stack is bounded by input. WebKit 26 overflowed at 2,500
  siblings where V8 handled 9,000, so preprocessing uses an engine-derived
  bound. See [the path-bound measurements](csp.md#the-path-bound-is-an-engine-measurement).

To iterate on Lean sources without rebuilding the images:

```sh
docker build --target toolchain -t guard-lean-toolchain lean/
docker run --rm -v "$PWD/lean:/guard" guard-lean-toolchain lake build
docker run --rm -v "$PWD/lean:/guard" guard-lean-wasm
```
