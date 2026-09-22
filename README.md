# Generative Web Guard

Security boundary for LLM-generated HTML, SVG, and JavaScript. This reference
implementation of [PLAN.md](PLAN.md) reduces markup to a structured tree with
an allowlist policy, then renders it with DOM constructors inside a sandboxed
null-origin iframe with a `default-src 'none'` CSP. Interaction code runs in
QuickJS (WebAssembly) in a Web Worker with memory, stack and time limits.

Read the [FAQ](docs/faq.md) for why we use Lean, how the scope differs from
DOMPurify, and how we respond to new exploits and CVEs.

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
PORT=8096 npm run serve      # host http://localhost:8096/ plus a second "CDN" origin on :8097
npm run check:browser        # end-to-end checks on pinned Chromium, Firefox and WebKit builds
npm run lean:build           # Lean 4 checker image (Docker; nothing installed on the host)
npm run check:lean           # differential: Lean checker vs policy.js on corpus + random inputs
```

## Check and filter HTML from the command line

Build the Lean/Wasm checker once, then pass a file or standard input through
the same candidate and Lean acceptance path used by the policy Worker. The
command writes canonical markup from Lean's accepted tree, so it is convenient
to redirect into a new file:

```sh
npm run wasm:build
npm run guard:html -- untrusted-page.html > filtered-page.html
printf '<h1>Hello</h1><script>alert(1)</script>' | npm run guard:html -- - > filtered.html
```

For a directory, process every `.html` and `.htm` file recursively and retain
its relative path beneath a separate output directory:

```sh
npm run guard:html -- untrusted-pages --out-dir filtered-pages
```

The command exits nonzero and writes a structured refusal to stderr when a
document exceeds a preprocessing limit or Lean does not accept the candidate.
It never falls back to JavaScript acceptance.

The runnable fixtures are in
[`examples/cli`](https://github.com/ti3x/generative-web-guard/tree/main/examples/cli).
From any directory, download the HTML example and filter it:

```sh
curl -LO https://raw.githubusercontent.com/ti3x/generative-web-guard/main/examples/cli/untrusted-page.html
npm run guard:html -- untrusted-page.html > filtered-page.html
```

Generated JavaScript is not rewritten into "safe JavaScript." Instead,
`guard:js` runs the program's initial view with the same QuickJS core and
default limits as the runtime, then filters that HTML through Lean/Wasm. A
program must define `initialState`, `update(state, event)`, and `view(state)`.
`--data` is optional; when present, its JSON value becomes a deep-frozen
`data` global inside QuickJS.

```sh
curl -LO https://raw.githubusercontent.com/ti3x/generative-web-guard/main/examples/cli/program.js
curl -LO https://raw.githubusercontent.com/ti3x/generative-web-guard/main/examples/cli/data.json

# No data: `data` is null in the program.
npm run guard:js -- program.js > filtered-view.html

# Optional input data.
npm run guard:js -- program.js --data data.json > filtered-view-with-data.html
```

`guard:js` evaluates only the initial view; it does not emit transformed
JavaScript. Browser interaction programs continue to run in the actual QuickJS
Worker, and every view they produce is accepted or refused by Lean/Wasm.

The browser check runs Chromium, Firefox and WebKit and **pins** the exact
Playwright builds it tests against: Chromium `140.0.7339.186`
(`chromium-1193`), Firefox `141.0` (`firefox-1490`), WebKit `26.0`
(`webkit-2203`). It asserts the launched build's reported version and fails on
a mismatch rather than silently using a different cached build. Restrict with
`ENGINES=webkit`; override a path with `CHROME_PATH` / `FIREFOX_PATH` /
`WEBKIT_PATH` plus `EXPECT_PINNED_VERSIONS=0`. Serve first and pass the URL:

```sh
PORT=8096 npm run serve
DEMO_URL=http://localhost:8096/ npm run check:browser
```

The supported browser matrix, the host CSP profiles, and the engine-specific
gaps are in [docs/csp.md](docs/csp.md). Two gaps are load-bearing: **Trusted
Types does not exist on Firefox 141**, and **WebKit 26 does not gate
`new WebAssembly.Module()` with CSP**.

## Browser CDN

The package ships two entry points, and the split is deliberate. The **integrated
`createGuard` API and the mandatory Lean/Wasm authority live in the `./full`
entry** (`cdn/generative-web-guard.full.min.js`). It embeds both the Lean
checker and the QuickJS Worker. The **default entry** contains bounded parse5
preprocessing, `createPolicySession`, `createGuardFrame`, and startup diagnostics,
with no embedded Worker. `checkTree`, `isValidated`, and synchronous `guardHtml`
are not public exports: JS-only validation cannot authorize a render.
See [Phase 6 measurements](docs/phase6-results.md) for distribution sizes.


`npm run build` writes two kinds of output. `dist/` contains local demo assets
and stays ignored; GitHub Actions uploads it as a workflow artifact. `cdn/` is
the public, self-contained ESM distribution and should be committed before a
release tag is created. Its npm dependencies are bundled, so browsers do not
need an import map or a package install.

Pin a release tag or, for the strongest immutability, a commit SHA:

```html
<script type="module">
  import { createGuard }
    from "https://cdn.jsdelivr.net/gh/ti3x/generative-web-guard@v0.0.1/cdn/generative-web-guard.full.min.js";

  // createGuard owns the whole boundary: the sandboxed frame, the policy
  // Worker with its embedded Lean/Wasm authority, the private port that
  // carries accepted trees straight from that Worker to the frame, and -- when
  // a program is supplied -- the QuickJS Worker. It resolves only once all of
  // that is ready, and rejects with a StartupError otherwise.
  const guard = await createGuard({
    container: document.querySelector("#generated-content"),
    onStatus(status) { /* bounded, trusted UI diagnostics */ },
  });

  // A static document: validated by Lean and committed, or a rejected result.
  await guard.render({ html: "<h1>Hello</h1><script>alert(1)</script>" });

  // An interactive document: the program runs in QuickJS, every view it
  // produces takes the same Lean acceptance path, and frame events route back
  // to it automatically. `data` is host JSON the program can read.
  const result = await guard.render({ program: generatedJs, data: hostDataset });
  if (result.status === "rejected") console.log(result.reason);

  await guard.clear();   // clears the display and stops interaction
  guard.dispose();       // idempotent; releases frame, Workers and ports
</script>
<div id="generated-content"></div>
```

The integrated API never hands back a raw view or an accepted tree, exposes no
way to mount into the frame, and takes no checker, renderer or skip-validation
option: every rendered document has passed the same Lean/Wasm acceptance, and a
`render` resolves `rendered` only after the frame acknowledged that exact
request. `render` returns `rejected` (with a bounded reason) or `superseded`
for expected failures, and throws only for API misuse or unavailable
infrastructure.

### The layer beneath

For custom composition, create the frame first and bind the policy session to
it. The session sends accepted trees directly to the frame; the host receives a
`rendered` acknowledgement, not a tree or a claimable rendering token.

```js
import { createGuardPolicySession, createGuardFrame } from "…/generative-web-guard.full.min.js";
const frame = createGuardFrame({ container });
const policy = createGuardPolicySession({ frame });
await Promise.all([frame.ready, policy.start(), frame.whenBound()]);
const result = await policy.preprocess("<h1>Hello</h1><script>alert(1)</script>");
// result.status === "rendered" only after the private-port acknowledgement.
await policy.preprocess(""); // clear through the same authority
policy.dispose();
frame.destroy();
```

A session with a frame holds its requests until the Worker confirms it holds
the private port, so the `Promise.all` above is for surfacing startup errors
early, not a prerequisite for safety. Every request declares its delivery
(`frame` or `host`); the Worker refuses a frame request it cannot deliver over
a port and a host request while a port is installed, and never chooses by
inference. A tree that nonetheless reaches a frame session ends that session.

An unbound frame is inert. There is no `frame.render`, `frame.clear`, or
`claimAcceptance` API. A session without a frame may return a Lean-accepted tree
for headless diagnostics, but cannot commit it to any frame. The optional
`{ preview: true }` request returns at most 16,000 characters of diagnostic
markup from the accepted tree; display it with `textContent`, never reparse it.

The full bundle also embeds the QuickJS worker and the Lean checker, avoiding
cross-origin Worker URL restrictions and any runtime asset fetch:

```js
import { createGuardRuntime } from
  "https://cdn.jsdelivr.net/gh/ti3x/generative-web-guard@v0.0.1/cdn/generative-web-guard.full.min.js";

const runtime = createGuardRuntime();
```

Both Worker payloads are embedded in the full bundle **as source** and are
created from `blob:` URLs. That is not an optimization: `new Worker` on a
cross-origin URL fails on Chromium, Firefox and WebKit under *every* CSP
including no CSP at all, because a dedicated worker's script is fetched
same-origin. A `blob:` Worker also inherits the host document's policy, which a
same-origin network Worker does not.

So a host page using the full bundle needs the adopted profile
([docs/csp.md](docs/csp.md)):

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

`<cdn>` is the bundle's origin (for jsDelivr, `https://cdn.jsdelivr.net`);
`<frameScript>` and `<frameStyle>` are the hashes on the exported `manifest`.
`connect-src 'none'` is sufficient because nothing is fetched at runtime: both
QuickJS and the Lean checker are embedded in the Worker payloads, and
`npm run check:browser` asserts on every engine that no request for a `.wasm`
asset is made. `'wasm-unsafe-eval'` is **not** `'unsafe-eval'`: `eval` and
`new Function` stay blocked, measured on all three engines. It is now required
twice over — without it neither QuickJS nor the acceptance checker can start,
and nothing renders at all. There is no `frame-src` token because `frame-src`
is not enforced for a `srcdoc` frame on any engine.

**If your host policy is nonce-based** (`'nonce-…' 'strict-dynamic'`, which is
what CSP Evaluator and most framework generators recommend), the `'self'` and
`<cdn>` tokens above are **ignored** and the library will half-start and hang.
Use Profile C in [docs/csp.md](docs/csp.md#profile-c--nonce--strict-dynamic-hosts):
the fix is a `nonce` attribute on the tag that loads the library, and the two
hashes plus `'wasm-unsafe-eval'` plus `worker-src … blob:` are still required.

If a startup stage fails, the library raises a `StartupError` with a stage and a
code (`csp-worker-blob`, `csp-wasm-unsafe-eval`, `csp-cdn-script-src`,
`frame-bootstrap-timeout`, ...) whose message names the directive to change.
Per-stage codes exist because three of these failures produce **no**
`securitypolicyviolation` report at all — in particular a missing frame script
hash, which is invisible to the host and only shows up as a bootstrap timeout.
`STARTUP_ERRORS`, `STARTUP_STAGES` and `STARTUP_TIMEOUTS` are exported from
both bundles.

Hosts that cannot allow `blob:` at all can use Profile B in
[docs/csp.md](docs/csp.md). It is not the default, there is no automatic
fallback to it, and it **removes CSP as a containment layer around both
Workers** — a same-origin network Worker does not inherit the document policy,
and was observed with working `eval`, working `new Function` and successful
cross-origin `fetch` under a document policy of `connect-src 'none'`. Read that
section before choosing it.

The full bundle also embeds the policy Worker. `createGuardPolicySession()`
returns a host-side session whose `preprocess(html)` parses and checks off the
main thread. Attached sessions settle with `rendered`, `rejected`, or
`superseded`; headless diagnostic sessions use `accepted` instead of `rendered`.

The optional program linter is no longer exported by the default bundle
(**breaking**: `gateProgram` moved out of `cdn/generative-web-guard.js`). It
ships as its own entry point so Acorn is not in the default dependency path:

```js
import { gateProgram } from
  "https://cdn.jsdelivr.net/gh/ti3x/generative-web-guard@v0.0.1/cdn/generative-web-guard.lint.js";
```

The GitHub workflow rebuilds and tests both distributions, rejects stale
committed `cdn/` files, and uploads `dist/` plus `cdn/` for inspection. GitHub
Actions artifacts are not served by jsDelivr; jsDelivr reads committed files
from the referenced tag or commit.

Before public distribution, add a project `LICENSE`. Bundled runtime
dependencies are MIT-licensed, but the repository currently does not declare
the license for Generative Web Guard itself.

## Data flow

```text
HTML / QuickJS view -> policy Worker: parse5 -> JS proposal -> Lean acceptCandidate
                                                        -> private port -> frame DOM
QuickJS update <- host event schema check <- frame events
```

Preprocessing is bounded before the policy runs: the source length is checked
before parse5 is invoked, and conversion is iterative under limits on raw node
count, depth, attribute count and bytes, names, text, and candidate bytes.
Exceeding a limit returns a structured rejection; exceeding the request budget
terminates the policy Worker, which is the only way to interrupt the parser.

There is no mandatory JavaScript AST denylist. QuickJS compiles the program
under memory, stack and time limits and checks the synchronous
`initialState`/`update`/`view` interface; the sandbox has no DOM, network,
storage, timers, host objects or module loader, so computed access and built-in
dynamic evaluation reach nothing (`test/confinement.test.js`). The optional
linter is a development diagnostic, shipped separately.

The rendering path never reparses HTML. The frame receives Lean's accepted tree
only over its private Worker port; sequence and identity checks reject replay
and foreign messages. The host wires the port but has no tree/token commit API.
Optional diagnostic preview strings are not rendered. Renderer construction
assertions remain, while repeated host/frame policy normalization is removed.

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
| `src/policy.js` | Validator algorithms and proposal builder; full `checkTree`/`isValidated` retained only for reference tests |
| `src/adapters/parse5.js` | Production HTML frontend: bounded, iterative parse5 to raw tree |
| `src/adapters/dom.js` | `DOMParser` adapter, kept only for parser-differential compatibility tests |
| `src/policy-protocol.js` | Policy-Worker protocol version, message envelope, and preprocessing limits (units named) |
| `src/policy-core.js` | Worker-side preprocessing, candidate construction and Lean/Wasm acceptance; no path accepts a document without the authority |
| `src/lean-abi.js` | The versioned single-document ABI: request builders, strict response validation, version and bounds constants |
| `src/lean-checker.js` | One WebAssembly instance, sealed at startup; poisons itself on a trap and never falls back |
| `src/lean-module.js` | The checker as a self-contained module: Emscripten factory plus the embedded binary |
| `src/acceptance.js` | Verdict identity records; retired registry retained only as a reference/test utility |
| `lean/Guard/Policy/Candidate.lean` | Production output-policy and canonical-representation acceptance |
| `lean/Guard/Props/CandidateReplay.lean` | Proof that candidate acceptance implies unchanged full reference acceptance |
| `lean/Guard/Wasm.lean` | Minimal production import root, excluding normalization, batch IO and proofs |
| `src/policy-worker.js` | Policy Worker entry; never executes generated JavaScript |
| `src/policy-client.js` | Host-side session: identity, generation, request ids, timeouts, termination |
| `src/render.js` | DOM construction and patching from a validated tree |
| `src/frame.js` | Code inside the sandboxed frame |
| `src/host.js` | Sandboxed frame creation, event schema, frame-bootstrap startup stage |
| `src/startup.js` | Per-stage startup budgets, startup error codes, and `blob:` Worker creation |
| `src/gate.js` | Optional development linter (diagnostic eligibility, never authorization); not on the execution path |
| `src/runtime/` | QuickJS core, worker entry, host-side controller |
| `scripts/build.mjs` | Bundles, CSP hash manifest, embedded checker binary, and the deterministic asset manifest |
| `scripts/wasm-audit.mjs` | Measures the checker's heap, linear stack and memory growth so the build's ceilings are evidence, not inheritance |
| `scripts/browser-check.mjs` | End-to-end browser verification |
| `scripts/lib/engines.mjs` | The three engines (JS, Lean in Docker, Wasm) behind the differential and Cucumber |
| `scripts/lean-differential.mjs` | Lean checker vs policy.js differential fuzzer |
| `scripts/rule-coverage.mjs` | Traceability gate over catalog, features, unit titles, code citations |
| `scripts/check-proofs.mjs` | Resolves advertised theorems in Lean and audits their transitive axioms |
| `scripts/check-policy-properties.mjs` | Independent output assertions, positive examples, fixed points, and negative controls |
| `scripts/security-scout.mjs` | Weekly GitHub Advisory Database filter and deduplicated triage issue report |
| `docs/csp.md` | Host CSP profiles, tested browser matrix with pinned versions, startup error codes |
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

`Guard.Props.Profile` adds the capability-kernel properties. `rules/capabilities.json`
is a separate reviewed kernel of closed element and attribute identities,
context-appropriate value grammars, mandatory controls and absolute resource
ceilings; a profile may only restrict it, and `npm run check:policy` rejects a
profile that does not, from the profile data alone. `default_profile_valid`
certifies the shipped profile against the generated inventory at build time.
Independently of the profile table, every accepted tree is then proved free of
the kernel's excluded identities (`src`, `href`, `style`, `name`, `iframe`,
`img`, `form`, `use`, ...), its `fill`/`stroke` values are solid colors, and
its ids carry the `g-` prefix. `restricts_permits` relates two profiles on
permitted **output trees**; it does not claim that a tighter profile accepts
fewer raw inputs. Widening the inventory is a kernel change, and neither the
generator nor an arbitrarily edited inventory is proved safe.

The production checker is `acceptCandidate`: output policy plus canonical
representation checks, with no normalization or replay. The theorem
`candidate_reference_fixed_point` proves that every accepted candidate would
pass the full reference checker unchanged with no changes. Generic profile
exclusions, validator canonicality, node/text bounds, attribute ordering and
uniqueness, and output-profile restriction are proved separately.

JS constructs a proposal and diagnostics once; Lean decides whether that
candidate is acceptable. The Worker sends only Lean's returned tree over the
private frame port. Missing, failing, rejecting, malformed or timed-out Lean
never falls back to JavaScript acceptance.

This is not a proof of JS equivalence, and differential tests never were one.
What changed is which implementation the browser obeys. Parsing, JSON
conversion, the C shim, the Emscripten runtime, the trusted glue, renderer
behavior, QuickJS, compilation and browser semantics all remain outside the
whole-checker theorems. See [verification scope and
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

The production build uses the minimal `Guard.Wasm` import root; the build rejects
reference normalization, batch IO, and proof modules in its dependency closure.
The binary remains embedded, not fetched, preserving `connect-src 'none'`.
See [Phase 6 results](docs/phase6-results.md) for before/after startup, memory,
latency, message copies, distribution sizes, and the compression experiment.

Four things were needed to get there and are worth knowing:

- Lean's runtime references four libuv functions for temp-file helpers. The wasm32 distribution ships no libuv, so `lean/wasm/shim.c` stubs them; the checker never touches the filesystem.
- Initializing with `lean_initialize()` and linking `libLean` produced a 56 MB module. Using `lean_initialize_runtime_module()` and linking only `libInit` and `libleanrt` brought it to 1.4 MB. This is also why `Guard/Core/Json.lean` exists instead of `Lean.Data.Json`.
- Emscripten's default 64 KB stack is far below what Lean assumes, but 16 MB turned out to be address space for nothing: `node scripts/wasm-audit.mjs` measures **104 bytes** of linear-memory stack for every case, because the recursion that matters compiles to wasm *call frames* on the engine's own stack, which `-sSTACK_SIZE` does not configure. The audited ceilings are now `INITIAL_MEMORY=80MB` (above the measured 52.43 MiB peak heap break, with no growth in the audit workloads), `MAXIMUM_MEMORY=128MB` (a real ceiling: growth with no maximum is not one) and `STACK_SIZE=1MB` with `STACK_OVERFLOW_CHECK=1`.
- The engine call stack is bounded by the *input* instead, and that bound is a per-engine measurement: WebKit 26 overflowed at 2,500 siblings where V8 managed 9,000. See [docs/csp.md](docs/csp.md#the-path-bound-is-an-engine-measurement).

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
| Isolation | Typically same origin, inside the host's React or Lit tree | Null-origin frame, CSP `default-src 'none'`, Trusted Types (Chromium/WebKit only; absent on Firefox 141), Web Worker |
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
blocked. The optional linter can report them up front for regeneration, but it
is a diagnostic: confinement does not depend on it.

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
in the frame's policy is `'none'`. Verified negatively on all three pinned
engines: remove the script hash and the frame never starts; remove the style
hash and it starts unstyled.

The full policy, the per-token justification, the tested browser matrix, the
startup error codes and the `blob:`-free fallback profile are all in
[docs/csp.md](docs/csp.md). `scripts/serve.mjs` emits the adopted profile for
the demo, and `?cspOmit=<token>` there removes one required token so the
corresponding startup error can be reproduced in a browser.
