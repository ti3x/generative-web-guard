# Generative Web Guard

Security boundary for LLM-generated HTML, SVG, and JavaScript. This reference
implementation of [PLAN.md](PLAN.md) reduces markup to a structured tree with
an allowlist policy, then renders it with DOM constructors inside a sandboxed
null-origin iframe with a `default-src 'none'` CSP. Interaction code runs in
QuickJS (WebAssembly) in a Web Worker with memory, stack and time limits.

```
npm install
npm run setup:verification   # once: prepare Lean and Emscripten toolchain images
npm test                     # fresh Lean/Wasm builds, proof audit, all-engine tests and behavioral properties
npm run test:js              # explicitly JS-only development checks; not full verification
npm run test:bdd             # Cucumber features (ENGINES=js,lean,wasm to run all three checkers)
npm run test:coverage        # rule -> scenario/proof/citation matrix; fails on any uncovered rule
npm run gen:rules            # regenerate src/rules.js and lean/Guard/Rules.lean from rules/catalog.json
npm run gen:policy           # regenerate JS/Lean tables and limits from rules/policy.json
npm run build                # dist/: frame bundle, worker, demo, CSP hashes
npm run check:cdn            # smoke-test the self-contained CDN distribution
PORT=8089 npm run serve      # http://localhost:8089/
npm run check:browser        # end-to-end checks in a local Chromium
npm run lean:build           # Lean 4 checker image (Docker; nothing installed on the host)
npm run check:lean           # differential: Lean checker vs policy.js on corpus + random inputs
```

The browser check needs a Chromium binary: set `CHROME_PATH`, or it finds a
Playwright cached headless shell or Chrome Canary. `BROWSER=firefox` runs the
same checks under a Playwright Firefox build (`FIREFOX_PATH` to override).

## Browser CDN

`npm run build` writes two kinds of output. `dist/` contains local demo assets
and stays ignored; GitHub Actions uploads it as a workflow artifact. `cdn/` is
the public, self-contained ESM distribution and should be committed before a
release tag is created. Its npm dependencies are bundled, so browsers do not
need an import map or a package install.

Pin a release tag or, for the strongest immutability, a commit SHA:

```html
<script type="module">
  import {
    guardHtml,
    createGuardFrame
  } from "https://cdn.jsdelivr.net/gh/OWNER/generative-web-guard@v0.1.0/cdn/generative-web-guard.min.js";

  const result = guardHtml("<h1>Hello</h1><script>alert(1)</script>");
  if (result.status === "validated") {
    const frame = createGuardFrame({
      container: document.querySelector("#generated-content")
    });
    await frame.render(result.tree);
  }
</script>
<div id="generated-content"></div>
```

The full bundle also embeds the QuickJS worker, avoiding cross-origin Worker
URL restrictions:

```js
import { createGuardRuntime } from
  "https://cdn.jsdelivr.net/gh/OWNER/generative-web-guard@v0.1.0/cdn/generative-web-guard.full.min.js";

const runtime = createGuardRuntime();
```

Pages using the full bundle need `worker-src blob:` in their CSP. Host pages
with a restrictive CSP must also permit the jsDelivr script origin and the
frame script/style hashes exposed by the exported `manifest`.

The GitHub workflow rebuilds and tests both distributions, rejects stale
committed `cdn/` files, and uploads `dist/` plus `cdn/` for inspection. GitHub
Actions artifacts are not served by jsDelivr; jsDelivr reads committed files
from the referenced tag or commit.

Before public distribution, add a project `LICENSE`. Bundled runtime
dependencies are MIT-licensed, but the repository currently does not declare
the license for Generative Web Guard itself.

## Data flow

```
generated HTML ──► non-executing parser ──► raw tree ──► policy ──► structured tree ─┐
                                                                                     ├─► postMessage ─► frame re-validates ─► DOM
generated JS ──► AST gate ──► QuickJS worker ──► view string ──► parser ─► policy ───┘        (null origin, CSP, Trusted Types)
                    ▲                                                                                    │
                    └────────────────────── plain-data events (schema-checked) ◄─────────────────────────┘
```

No HTML string exists after the policy runs. The frame accepts only trees that
are a fixed point of the policy, so a forged or stale tree is refused whoever
sent it.

## Layout

| Path | Purpose |
|---|---|
| `rules/catalog.json` | Security rules: id, class, statement, mechanisms, citing code, proofs, CVE references |
| `rules/policy.json` | Editable shared HTML/SVG tables, validator descriptors, forced values, and limits |
| `src/policy-data.js` | Generated JS policy tables and limits |
| `src/rules.js`, `lean/Guard/Rules.lean` | Generated rule ids (do not edit) |
| `features/` | Cucumber features tagged `@rule:`/`@cve:`, step definitions, engine hooks |
| `red-team/corpus.json` | Reviewable hostile-input corpus with provenance, rule links, and preservation expectations |
| `src/tree.js` | Tree format and structural limits |
| `src/policy.js` | Validator algorithms, descriptor interpreter, normalizer, output checks, `checkTree`, `isValidated` |
| `src/adapters/` | `DOMParser` and parse5 adapters producing raw trees |
| `src/render.js` | DOM construction and patching from a validated tree |
| `src/frame.js` | Code inside the sandboxed frame |
| `src/host.js` | Sandboxed frame creation and event schema |
| `src/gate.js` | AST gate for the interaction program |
| `src/runtime/` | QuickJS core, worker entry, host-side controller |
| `scripts/build.mjs` | Bundles and CSP hash manifest |
| `scripts/browser-check.mjs` | End-to-end browser verification |
| `scripts/lib/engines.mjs` | The three engines (JS, Lean in Docker, Wasm) behind the differential and Cucumber |
| `scripts/lean-differential.mjs` | Lean checker vs policy.js differential fuzzer |
| `scripts/rule-coverage.mjs` | Traceability gate over catalog, features, unit titles, code citations |
| `scripts/check-proofs.mjs` | Resolves advertised theorems in Lean and audits their transitive axioms |
| `scripts/check-policy-properties.mjs` | Independent output assertions, positive examples, fixed points, and negative controls |
| `scripts/security-scout.mjs` | Weekly GitHub Advisory Database filter and deduplicated triage issue report |
| `docs/VERIFICATION.md` | Rule maintenance workflow, exact proof scope, and why Lean is useful |
| `docs/RED_TEAMING.md` | Hostile-input intake, weekly advisory scout, and optional agent-review design |
| `scripts/gen-rules.mjs` | Generates rule id files from the catalog; `--check` in `npm test` |
| `lean/` | Lean 4 executable specification, proofs, Dockerfile |
| `demo/` | Host page with benign and attack samples |

## Lean 4 checker

`lean/` holds a second implementation of the policy in Lean 4, built and run
only inside Docker. Nothing is installed on the host. It is the executable
specification: the same tables as `src/policy.js`, the same validators written
as plain recursive functions over character lists, and a JSON batch interface
shared by a native executable and a WebAssembly export.

| Path | Contents |
|---|---|
| `lean/Guard/Rules.lean` | Generated rule ids (`Guard.R`) |
| `lean/Guard/Core/` | Chars, ListUtil, Limits, Json (self-contained), Tree |
| `lean/Guard/Validators/` | Number, Text, Ident, Color, Path, Transform. All total. |
| `lean/Guard/Policy/` | Val descriptors, generated Tables/{Html,Svg,Attrs}, total Check, output predicate Accept |
| `lean/Guard/Props/` | Proofs, one file per validator family; Checker holds `IsValidated` |
| `lean/Guard/Io/Api.lean` | `processRequest` and the `@[export guard_check]` symbol |
| `lean/Tests/` | `#guard` unit checks and the `guard-tests` executable |
| `lean/wasm/` | Emscripten shim and build script |
| `lean/README.md` | Layout, conventions, commands |

**Toolchain pin.** `lean/lean-toolchain` pins `v4.15.0`. That is the last
Lean release that publishes a prebuilt wasm32 runtime; later releases would
require building Lean's own runtime under Emscripten. One pinned version
serves proofs, the differential and the Wasm build.

### What is proved

Theorems cover validator results and accepted Lean output trees. The full test
command checks that advertised names are compiled theorems and that their
transitive axioms are limited to Lean's foundational axioms.

- Ids: emitted ids carry the `g-` prefix; id rewriting is idempotent.
- Numbers: every character of a canonical number is a digit, `.` or `-`; of a number list, those or a single space.
- Path data: every character is a command letter, a digit, `.`, `-` or a space.
- Transforms: the output is a space-joined list of groups, each `name(nums)` with a name from the fixed table and number-list characters inside.
- Colors: the output is a named color, `currentColor`, `#` followed only by hex digits, or a string accepted by the `rgb()` recognizer.

Whole-checker properties are now proved in `Guard.Props.Checker`: every accepted
tree satisfies `policyOk`, its nodes and text are bounded, every nested element
is allowlisted with canonical attributes, no script element or inline handler
survives, and revalidation returns the identical tree with no changes.

These are proofs about a **guarded acceptance function**. The total normalizer
first creates a candidate; a separate structural predicate checks it, and a
second normalization must leave it unchanged. Failed postconditions reject the
document. This adds runtime work and can reject a candidate that the earlier
normalizer would have released. It does not prove the normalizer always produces
acceptable output. Both JS and Lean implement these acceptance checks.

The demo still uses the JavaScript checker. Lean proofs do not transfer to JS
through differential tests; a formal JS equivalence proof is not present.
Parsing, JSON conversion, renderer behavior, QuickJS, compilation, and browser
semantics remain outside the whole-checker theorems. See [verification scope and
maintenance](docs/VERIFICATION.md).

### Differential testing

```
npm run lean:build           # native checker image (target: checker)
npm run check:lean           # corpus + random HTML through both checkers
GUARD_LEAN_MOUNT=1 npm run check:lean   # use the binary in lean/.lake instead of the image
NEGATIVE_CONTROL=1 npm run check:lean   # must report mismatches, or the comparison is broken
```

The differential feeds identical parse5 output to both checkers and compares
status, tree and change count with key order normalized. To make exact
agreement possible, the JavaScript validators use the same syntactic style:
numbers are canonicalized by string rewriting rather than `Number()`, path
data and transforms use sequential tokenizers, hex colors keep their case, and
name lowercasing is ASCII only.

### WebAssembly build

```
npm run wasm:build           # Emscripten SDK + Lean wasm32 runtime image, then link
npm run check:wasm           # load lean/wasm/dist/guard.mjs in Node, compare to policy.js
```

Measured on this machine:

| | |
|---|---|
| `guard.wasm` | 1.4 MiB (plus 70 KiB JS glue) |
| Initialization | about 20 ms |
| 2000 random cases | about 130 ms |
| Mismatches against `policy.js` | 0 |

Three things were needed to get there and are worth knowing:

- Lean's runtime references four libuv functions for temp-file helpers. The wasm32 distribution ships no libuv, so `lean/wasm/shim.c` stubs them; the checker never touches the filesystem.
- Initializing with `lean_initialize()` and linking `libLean` produced a 56 MB module. Using `lean_initialize_runtime_module()` and linking only `libInit` and `libleanrt` brought it to 1.4 MB. This is also why `Guard/Json.lean` exists instead of `Lean.Data.Json`.
- Emscripten's default 64 KB stack is far below what Lean assumes. Requests of a few hundred inputs crashed with an out-of-bounds access until the stack was raised to 16 MB.

**Iterating on Lean sources** without rebuilding images:

```
docker build --target toolchain -t guard-lean-toolchain lean/
docker run --rm -v "$PWD/lean:/guard" guard-lean-toolchain lake build
docker run --rm -v "$PWD/lean:/guard" guard-lean-wasm      # rebuild the .wasm from current sources
```

## Security rules, BDD scenarios and CVE regressions

`rules/catalog.json` is the single source of truth for what the system
defends against. Each rule has an id such as `R-EXEC-SCRIPT`, a class, a
given/when/then statement, the mechanisms that enforce it, the code that cites
it in both languages, the Lean theorems that cover it, and verified references
(CVE ids with the advisory URL and the sanitizer configuration the original
attack needed).

**Rule ids are first-class in the checkers.** Every change record the policy
emits carries `rule`, in JavaScript and in Lean, and the differential compares
them. So a test can assert not just that `<script>` is gone but that the
element-drop rule for scripts is what removed it.

**Scenarios are Gherkin.** `features/*.feature` hold one file per rule class
plus `cve-regressions.feature`, one scenario per CVE with its payload or a
marked reconstruction. Tags `@rule:R-…` and `@cve:CVE-…` link scenarios to
the catalog. Policy scenarios run `When every engine validates it` and end
with `Then all engines agree`, so each one is also a three-way differential.
Runtime, gate, frame and renderer rules have JavaScript-only scenarios with
QuickJS and jsdom.

```
npm run test:bdd                                   # JavaScript checker
GUARD_LEAN_MOUNT=1 ENGINES=js,lean,wasm npm run test:bdd   # all three checkers; a missing engine fails
```

**The coverage gate** (`npm run test:coverage`, part of `npm test`) prints a
matrix of rule, class, engines, scenario count, unit tests, citations in each
language, proofs and CVE references, and fails on: a rule with no scenario, a
scenario with no rule tag, an unknown rule or CVE tag, a catalog CVE without a
scenario, stale generated ids, a rule cited in only one language, or a cited
file that does not exist. Unit test titles carry `[R-…]` prefixes so grep links
them to rules as well.

Modeled CVEs: DOMPurify (CVE-2019-16728, CVE-2020-26870, CVE-2024-45801,
CVE-2024-47875, CVE-2024-48910, CVE-2025-26791), bleach (CVE-2020-6802,
CVE-2020-6816, CVE-2020-6817, CVE-2021-23980), rails-html-sanitizer
(CVE-2022-32209, CVE-2024-53985 through 53989), Loofah (CVE-2018-8048). Each
was checked against the GitHub advisory before being recorded; rules that
lack a CVE cite a writeup or browser behaviour instead, and nothing is tagged
with an unverified id.

## How this compares to json-render and A2UI

The structured tree looks like a JSON UI spec, so this project is often
mistaken for the same idea as Vercel's json-render or Google's A2UI. The
resemblance is real but the trust boundary sits in a different place.

**In the catalog approach the JSON is the model's output.** The model emits
component names, props, bindings and actions against a host-defined catalog
(Card, Table, Button, Chart). A trusted renderer maps each entry to a real
implementation. Security comes from the model only being able to name things
that exist in the catalog.

**Here the tree is the checker's output, never the model's.** The model writes
ordinary HTML, SVG and JavaScript. A policy reduces the markup to a tree of
about ninety allowlisted elements with typed attributes, and that tree is what
crosses into the frame. The model never sees or produces the tree format.
The tree exists so that nothing after validation is an HTML string, which
removes re-parse attacks as a class. It is a rendering contract, not an
authoring format.

Put differently: json-render and A2UI are a catalog of ~20 high-level
components that the model targets directly. This is a catalog of ~90 low-level
elements that a checker targets after the model has written familiar markup.
Same shape, different altitude, different author.

### Side by side

| | Catalog JSON (json-render, A2UI) | This project |
|---|---|---|
| What the model writes | JSON against a bespoke schema | HTML, SVG, JS it has seen in training at scale |
| Parsing surface | JSON schema check | HTML5 parser plus SVG plus policy tables |
| Proof effort | Small: schema membership | Larger, and browser parser differentials sit outside the model |
| Where bugs live | Component implementations and prop types | Policy tables and renderer |
| Custom visuals | Only if the catalog has a component for it | Any SVG within numeric and structural bounds |
| Logic | Data bindings and a small expression language | Arbitrary synchronous JS in QuickJS with limits |
| Design consistency | Guaranteed by the components | Bundled class allowlist; layout is model-composed |
| Streaming | Progressive render of partial JSON | Whole view per update |
| Isolation | Typically same origin, inside the host's React or Lit tree | Null-origin frame, CSP `default-src 'none'`, Trusted Types, Web Worker |
| Cost of a new capability | Write and maintain a component | Add allowlist rows |

### Where the catalog approach is better

- **Smaller surface by construction.** No HTML parser to disagree with the
  browser, no mutation XSS class, no SVG integration points. Schema membership
  is the easiest thing to prove.
- **Consistency and accessibility** are built into components once.
- **Tokens and streaming.** A component name and props cost far less than
  markup, and partial JSON can render while the model is still generating.

If the product is an assistant that shows cards, tables, forms and a fixed set
of chart types from a design system, use a catalog. That is the better trade.

### Where it does not solve this project's problem

- **The escape hatch reappears.** The stated goal is custom information
  visualizations. A catalog has no "draw this bespoke chart" component unless
  it adds an SVG, Markdown or HTML primitive, and that primitive is exactly the
  sanitizer problem this repository exists to solve. Any catalog component that
  takes a URL prop or renders rich text carries the same risk at smaller scale.
- **Logic is weaker.** A calculator with model-written formulas or a sort
  comparator the model invents does not fit a binding language. See
  [Real calculation logic](#real-calculation-logic) below.
- **Isolation is usually weaker.** Catalog renderers run in the host page, so a
  bug in one component is a same-origin XSS. Nothing prevents a catalog renderer
  from using a sandboxed frame, but the reference implementations do not, and
  the frame is the single strongest control here.
- **Model reliability.** Models produce valid HTML more consistently than valid
  instances of a schema seen only in the prompt.

### The layered option

Because the tree is already a low-level catalog, a high-level catalog can sit on
top of it:

1. Keep the bottom layer as built: tree, constructor-only renderer, null-origin
   frame, QuickJS worker.
2. Let the model emit component JSON for common widgets. Trusted code expands
   each component into a validated tree. This gives consistency, fewer tokens
   and streaming for the common case, with proofs that are mostly schema
   membership.
3. Keep HTML and SVG as the escape hatch through the same policy and the same
   frame.

If the escape hatch turns out to be rarely used, drop it and the result is A2UI
with better isolation. If it is used constantly, the sanitizer earned its keep.
Only the policy tables shrink in a catalog-only world, and they are the
cheapest part.

Both json-render and A2UI are young (A2UI pre-1.0, json-render first released
early 2026), so expect schema and API churn if adopting either directly rather
than borrowing the idea.

## Real calculation logic

Calculation is ordinary JavaScript in `update` and `view`. It runs unmodified
in QuickJS with the full language and standard library: numbers, BigInt, Math,
strings, regular expressions, arrays, Map and Set, Date, JSON, closures,
classes and recursion. The restrictions are about reach, not computation:
fetch, timers, DOM, storage and imports are absent from the runtime rather than
blocked, and the AST gate reports them up front.

Defaults: 200 ms interrupt per step, 32 MiB memory, 512 KiB stack, 400k
character view. All are configurable in `src/runtime/core.js`.

**Host-supplied data.** The host keeps the dataset and passes it to
`runtime.load(source, data)`. It is serialized once, injected into QuickJS as
a deep-frozen global named `data` before the program runs, and never appears
in model output. The model writes code that reads `data` and the host can
label displayed numbers as coming from the real source. Without host data the
global is `null`. Default size limit 4 MiB.

Practical notes for writing or prompting this code:

- Every event value is a string. Convert and validate; fall back on bad input
  rather than rendering NaN.
- State must survive JSON. Dates become strings, Map and Set vanish, functions
  cannot be stored. Keep derived values out of state and recompute in `view`.
- No `Intl`. QuickJS has no locale data, so format numbers and dates by hand.
- `update` and `view` are pure, so the host can replay any event sequence
  without a browser for debugging or tests.
- A step that exceeds its budget is interrupted, the runtime is marked dead,
  the last validated view stays on screen and the host shows the failure.

## Integrating into a host page

The host page's own CSP must include the frame bundle's script hash and the
stylesheet hash from `dist/frame-manifest.json`, because a `srcdoc` frame
inherits the embedding page's policy before applying its own. Everything else
in the frame's policy is `'none'`.
