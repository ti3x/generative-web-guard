# Policy maintenance and verification

The policy is an allowlist over a structured HTML/SVG tree. A parser creates an
untrusted tree, a normalizer reconstructs a candidate, and acceptance checks
decide whether that candidate may leave the checker.

**The browser now runs the Lean checker compiled to WebAssembly as the
acceptance authority.** The JavaScript implementation still runs, as a
candidate builder and a source of diagnostics, and its candidate must equal
Lean's accepted tree exactly or the document is refused. The tree that reaches
the DOM is the tree `Guard.checkTree` returned, and a frame commit requires a
one-time acceptance record minted next to that verdict. See
[the acceptance authority](#the-acceptance-authority-in-production) below for
what that does and does not establish.

## What to edit

| Change | Source of truth |
|---|---|
| Add/remove an element or attribute | `rules/policy.json`, within `rules/capabilities.json` |
| Change an enum, numeric range, fixed value, or size limit | `rules/policy.json`, within `rules/capabilities.json` |
| Permit a *new* identity, widen a grammar, or raise a ceiling | `rules/capabilities.json` (kernel change) |
| Explain a restriction and link evidence | `rules/catalog.json` |
| Change a custom value grammar | JS validators in `src/policy.js` and Lean `Guard/Validators/` |
| Change traversal or acceptance semantics | `src/policy.js`, Lean `Policy/Check.lean` and `Policy/Accept.lean` |
| Add an exploit regression | A tagged scenario under `features/`, with explicit expected behavior |

`sharedGlobal` in the schema holds attributes shared by HTML and SVG; namespace
tables add their own entries. For example, `"r": ["nonNeg"]` selects the same
radius validator in both languages, and `["int", 1, 100]` specifies a bounded
integer. `["tagged", "R-...", descriptor]` assigns an explanatory rule ID.

Run `npm run gen:policy` after editing the schema and `npm run gen:rules` after
editing rule identities. Generated tables, limits, and rule IDs are checked for
staleness by `npm test`. The old independent ARIA table was removed; shared ARIA
attributes and roles now live in the schema.

The drop-rule maps determine the explanation for a removal. Permission comes
from the allowlists. Adding a drop-rule entry cannot revoke an allowed element.

## The capability kernel

`rules/capabilities.json` is a separate, reviewed kernel that bounds every
profile: closed element and attribute identities, the widest value grammar
reviewed for each attribute *in its context*, the mandatory control
attributes, the mandatory text-only SVG contexts, the reviewed unwrappable
elements, absolute resource ceilings, and explicit exclusions. It is generated
into `src/capabilities-data.js` and `lean/Guard/Policy/Capabilities.lean`.

A profile may only restrict it, and `scripts/gen-policy.mjs` enforces that
before emitting any table, so `npm run gen:policy` and `npm run check:policy`
fail on an unsafe profile whether or not a matching exploit appears in any
corpus:

- enumerations restrict by set inclusion, integer ranges by interval
  inclusion, number lists by a smaller bound;
- every other grammar requires **exact identity**. There is no implication
  solver, no regular expression and no callback, so `title` may use plain text
  while SVG `fill`/`stroke` must keep the restricted solid-paint validator;
- an element or attribute identity outside the inventory cannot be introduced,
  so a resource URL attribute cannot be declared with a text grammar;
- a forced control attribute cannot be removed or retargeted while its element
  stays permitted, and a limit cannot exceed its ceiling.

The restriction relation is implemented twice, in
`scripts/gen-policy.mjs` (`restricts`) and in Lean (`Val.restricts`), for the
same reason the validators are: a shared executable definition would enlarge
the trusted generator. `npm test` runs both against the shipped profile --
`npm run check:policy` and the `#guard profileValid caps defaultProfile` in
`lean/Tests/Tables.lean` -- so a disagreement about *this* profile fails the
build. It is not a proof that the two relations agree on every profile.

`capabilityVersion` versions the inventory's *meaning*, recorded in the
`meaning` and `reviewScope` fields. Widening the inventory is a kernel change:
it needs security review of browser effects, renderer assumptions, tests and
proof scope, plus a version increment. Neither the generator nor an arbitrarily
edited inventory is proved safe by anything here.

`maxTraversalDepth` is a structural traversal ceiling. Unlike `maxDepth` it
counts every descent, including chains of unwrapped elements that do not
increase output depth, and both checkers reject `traversal-depth` at the same
point. It sits above the preprocessing raw-depth bound, so it is reachable
only by calling `checkTree` directly with a hand-built raw tree.

Custom validator algorithms remain independent JS and Lean implementations.
Generating both from arbitrary shared executable code would expand the trusted
generator and weaken the value of independent differential checks. The shared
descriptors remove duplication of choices and parameters, not the need to review
both algorithms when their semantics change.

## The acceptance authority in production

The shipped path is:

```text
bounded HTML -> parse5 (bounded, iterative) -> raw tree
  -> JS candidate builder            (a proposal and diagnostics)
  -> Lean/Wasm Guard.checkTree       (THE AUTHORITY)
  -> accepted tree + one-time acceptance record
  -> frame commit
```

`checkTree` is the existing whole-checker entry point, so an accepted tree
carries its output-policy postcondition and its replay — a second
normalization that must reproduce the tree with no further changes. Nothing
renders a candidate on the strength of an unrelated success flag: the tree in
the reply is the tree that call returned.

**There is no fallback.** A missing module, a failed instantiation, a version
or bounds mismatch, a rejection, a malformed response, a trap and a timeout all
produce a structured refusal. Falling back to the JavaScript checker would
bypass the authority, so the library refuses to render instead. The negative
controls in `test/lean-authority.test.js` break the authority nine different
ways — reject a benign document, remove the module, corrupt it, stall it, spoof
a reply, replay a reply, force the candidate builder to emit a forbidden tree,
try to install a checker through a message, and make the module trap — and each
one must prevent rendering or produce a bounded failure.

### The ABI

The WebAssembly module exports a **versioned, bounded, single-document ABI**
(`lean/Guard/Io/Abi.lean`, `src/lean-abi.js`) and nothing else. The permissive
batch interface that takes a list of documents and a caller-supplied class list
has no `@[export]` any more and reaches only the native executable, where it is
a differential-testing tool.

What is bound to the **built instance** rather than to a request:

| | How |
|---|---|
| profile, tables, validators, limits | compile-time constants; there is no profile loader and no `limits` field in any request |
| checker version, capability version | compile-time constants, echoed in every response; the glue refuses a module that reports anything else |
| class allowlist, stylesheet identity | supplied once at startup from the build-time frame manifest and **sealed** by the C shim; a later differing configuration is refused |

A `check` request carries exactly `{ abi, op, requestId, document }`. Anything
else in it — `classes`, `profile`, `limits`, a `tree` — is an `unknown-field`
error, so there is no field on the hot path through which generated content
could influence the policy.

### Strict decoding, and what `rawFromJson` actually is

`Guard.Io.decodeDocument` is the decoder the ABI uses. It is total (fuel-bounded
recursion, no `partial`), bounded, and it **refuses rather than repairs**:
unknown `kind`, missing or mistyped field, extra field, duplicate object key,
malformed attribute entry and duplicate attribute name are all errors.

`Guard.rawFromJson` is **not** that, and must not be described as a strict
candidate decoder. It is `partial`, it silently defaults a missing or mistyped
field, it **drops** a malformed attribute entry, it resolves a duplicate object
key to the first occurrence, it keeps duplicate attribute names, and it bounds
nothing. That is acceptable for a differential-testing tool whose job is to
feed both implementations the same parser output; it is not acceptable for an
authority, because "repair silently" and "decide" must not live in the same
function. `Guard/Core/Tree.lean` documents the behaviour item by item.

The two decoders therefore disagree on a hand-built raw tree with a duplicate
attribute name — the ABI refuses it, the lenient path resolves it. parse5 never
produces one (the HTML parsing spec drops duplicates in a start tag), and
`scripts/check-policy-properties.mjs` asserts the divergence explicitly rather
than excluding the case.

Conversion behaviour is pinned by compile-time `#guard`s in `lean/Tests/Abi.lean`
and by tests through the real module: duplicate fields, duplicate attributes,
NULs, lone surrogates (mapped to U+FFFD by the JSON reader), supplementary
characters (two UTF-16 code units on both sides), and exact byte-for-byte tree
round trips.

### Memory, stack and cost

Lean's termination proofs bound steps. They say nothing about bytes or
wall-clock time, so those are independent obligations, discharged by
measurement:

- `node scripts/wasm-audit.mjs` paints the unused linear stack and scans it
  after the worst legal document, and reads the heap break and memory size.
  Measured on this checkout: heap break 18.3 MiB after instantiation and
  53.6 MiB at the worst legal document; **104 bytes** of linear-memory stack in
  every case.
- The ceilings in `lean/wasm/build.sh` come from those numbers:
  `INITIAL_MEMORY=80MB` (above the measured worst case, so a hostile document
  does not also pay for a whole-heap copy on growth), `MAXIMUM_MEMORY=128MB`
  (a real ceiling — `ALLOW_MEMORY_GROWTH` with no maximum is unbounded
  growth), `STACK_SIZE=1MB` (the previous 16 MB was address space for nothing)
  and `STACK_OVERFLOW_CHECK=1`.
- The **engine** call stack is the one that matters and no build flag
  configures it: the checker recurses once per sibling, in `mutual` blocks Lean
  does not turn into loops. That bound goes on the input instead, and it is a
  per-engine measurement — see
  [docs/csp.md](csp.md#the-node-bound-is-an-engine-measurement).
- The C shim (`lean/wasm/shim.c`) uses one static staging buffer of fixed
  capacity, does not export `_malloc`/`_free`, validates UTF-8 before building
  a Lean string, passes explicit lengths in both directions so a NUL can never
  truncate a document or a verdict, and owns the single response buffer with an
  idempotent release.

### What this does not establish

Lean's theorems are about `checkTree`. They say nothing about the Emscripten
runtime, the C shim, the JSON codec on either side, `src/lean-checker.js`,
`src/policy-core.js`, the message transport, the renderer, the browser, or
QuickJS isolation. All of those remain trusted glue with their own adversarial
and browser evidence. Compiling the proved checker into the shipped Wasm closes
the JS-reference gap for *acceptance*; it does not prove the compiler, the FFI
or the surrounding code.

## Exact whole-checker guarantees

The Lean boundary is `checkTree : Ctx → List Raw → Result`. Parsing strings and
converting JSON to `Raw` happen before that boundary.

| Theorem | Guarantee for every accepted output |
|---|---|
| `accepted_policy` | The explicit output predicate holds |
| `accepted_structure` / `accepted_descendant` | All nodes, including nested descendants, satisfy the recursive predicate |
| `accepted_element_allowed` | Every descendant element is in the namespace's allowlist and has canonical attributes |
| `accepted_no_script` | No HTML or SVG `script` element occurs anywhere in the tree |
| `accepted_no_handler` | No attribute starts with `on` or contains a namespace prefix separator |
| `accepted_node_bound` / `accepted_text_bound` | Global node count and UTF-16 text size stay within configured limits |
| `accepted_idempotent` | Rechecking the output returns exactly that tree with an empty change list |
| `accepted_no_excluded_element` / `accepted_no_excluded_attribute` | No identity the reviewed kernel excludes occurs anywhere in the tree |
| `accepted_no_active_html_element` / `accepted_no_active_svg_element` | Named concrete exclusions: `iframe`, `object`, `img`, `form`, `a`, `use`, `animate`, ... |
| `accepted_no_resource_attribute` | Named concrete exclusions: `src`, `href`, `style`, `name`, `__proto__`, `filter`, ... |
| `accepted_paint_is_solid_color` / `accepted_paint_grammar` | Accepted `fill`/`stroke` is a named colour, `currentColor`, a hex colour or `rgb()` |
| `accepted_id_is_prefixed` | Every accepted `id` value starts with `g-` |

The recursive predicate also checks namespace transitions, element depth,
text-only SVG contexts, cleaned nonempty text, attribute counts, canonical
validator results, and forced control attributes.

These theorems apply to a guarded acceptance function. The normalizer uses total
recursion with decreasing fuel. Its candidate must pass the output predicate
and a second normalization. This makes acceptance sound even if a future
normalizer change produces an invalid candidate: the document is rejected.
It adds predicate evaluation and a normalization pass. It is not a proof that
normalization always succeeds or never changes a benign document unnecessarily.

## Profile theorems

| Theorem | Guarantee |
|---|---|
| `caps_consistent` | The reviewed inventory contradicts none of its own exclusions, and no element table shadows a global attribute |
| `default_profile_valid` | The shipped profile stays within that inventory and under its ceilings |
| `valid_excludes_attr` / `valid_excludes_element` | *Any* profile that certifies permits no excluded identity, in any element context |
| `valid_attr_within` / `restricts_apply` | Every validator a certified profile uses restricts the reviewed one, and everything it accepts canonically the reviewed grammar accepts canonically |
| `valid_limits`, `within_max*` | A certified profile's limits are bounded by the ceilings |
| `valid_forced`, `valid_required`, `valid_text_only` | Mandatory controls and text-only contexts survive certification |
| `restricts_permits` | If `p2` restricts `p1`, every output tree `p2` permits is permitted by `p1` |

The accepted-output exclusions and value contracts above are derived from
`caps_consistent` plus a general lemma about *any* certified profile, not by
quoting the profile table back at itself. `default_profile_valid` and
`caps_consistent` are decided on the concrete generated data at build time, so
a widened profile or a stale generated inventory fails to compile.

`restricts_permits` concerns permitted **output trees**. It does not say that a
tighter profile accepts fewer raw inputs: a tighter profile can remove more
content from an input and still accept a smaller output. Arbitrary runtime
profile loading is deliberately not part of this release; production acceptance
always runs `defaultProfile`.

The existing validator proofs cover particular grammar properties. For example,
the color proof characterizes named/hex/RGB recognizer output; it does not prove
the browser's complete CSS color semantics. A theorem must be read at its actual
type rather than inferred from its name or a catalog title.

## Verification commands

Start Docker, then prepare the toolchains once:

```sh
npm run setup:verification
```

`npm test` is the full verification command. It:

1. Checks generated rule IDs, policy tables, and limits for staleness.
2. Requires the Lean and Wasm toolchain images; missing images fail the run.
3. Builds the current Lean library, native checker, and native tests from the
   mounted working tree. It does not rely on a possibly stale checker image.
4. Resolves each advertised proof in Lean, requires it to be a theorem, and
   audits its transitive axioms. Only `propext`, `Classical.choice`, and
   `Quot.sound` are allowed; admitted proofs and custom axioms fail verification.
5. Rebuilds Wasm from the same sources, then runs unit tests and BDD scenarios
   with JS, native Lean, and Wasm explicitly required.
6. Checks independent safety assertions, an exact benign output, and fixed
   points against all three engines. Negative controls ensure the oracle rejects
   representative unsafe outputs; positive controls detect rejecting or erasing
   all content.
7. Checks rule-to-test/code traceability, clearly labeled as traceability.

The Wasm engine in the differential and in the Cucumber hooks goes through the
**production** path — `src/lean-checker.js` over the single-document ABI, one
document per call — so what agrees with `src/policy.js` is the exact interface
the browser uses, not a separate batch entry point. The native Lean engine
still uses the batch interface, which is what makes the strict-decoder
divergence above visible and asserted.

The distribution is verified separately, because `npm test` does not build it:

```sh
npm run build      # twice, and diff cdn/ to check reproducibility
npm run check:cdn
```

`check:cdn` recomputes the sha256 of every artifact `cdn/asset-manifest.json`
names and fails on a mismatch, which is the stale-artifact check: a rebuilt
checker with a forgotten bundle, or the reverse, is detectable instead of
silently inconsistent. Those hashes **bind build contents and detect
mismatch**; they do not prove provenance. Nothing is signed, and a hash says
nothing about which toolchain or which sources produced the input — that comes
from building in CI from the checkout and from the proof audit.

`npm run build` refuses to run at all without `lean/wasm/dist/guard.wasm`,
because the distribution embeds the checker. There is deliberately no
JavaScript-only bundle variant: one could not render anything.

`.github/workflows/build.yml` runs this as an unconditional job: it builds the
pinned toolchain images (caching the images only, never a proof result or a
build directory), rejects missing toolchains and stale generated files, runs
`npm test` from the checkout, and fails on any working-tree drift afterwards.
Required branch checks are a repository-settings task tracked separately;
adding workflow YAML does not enable branch protection.

`npm run test:js` is a faster, explicitly limited development command. It does
not establish that Lean compiled, proofs passed, or Wasm agreed. Individual
`check:lean`, `check:wasm`, and `check:proofs` commands assume their prerequisite
builds are current; use `npm test` for the complete source-to-test sequence.

Browser behavior still needs separate verification:

```sh
npm run build
PORT=8096 npm run serve            # host :8096, second "CDN" origin :8097
# In another terminal:
DEMO_URL=http://localhost:8096/ npm run check:browser
```

`check:browser` runs three engines on **pinned** Playwright builds and asserts
each launched build's reported version, so a pass is attributable to a specific
engine: Chromium `140.0.7339.186` (`chromium-1193`), Firefox `141.0`
(`firefox-1490`), WebKit `26.0` (`webkit-2203`). It does not fall back to a
newer cached build; selecting "the newest cached build" is how two conflicting
version sets previously ended up in the project's claims. Restrict with
`ENGINES=firefox`.

Beyond the rendering and runtime checks, it measures the host-CSP claims rather
than quoting them: the cross-origin bundle creating both `blob:` Workers, Wasm
compiling inside a Worker that inherits the document policy, `eval` and
`new Function` still refused there, and each startup error code reached by
removing exactly one required token from the host policy. The profiles, the
support matrix and the engine-specific gaps are in
[csp.md](csp.md); three of those gaps limit what may be claimed at all —
Trusted Types does not exist on Firefox 141, WebKit 26 does not gate
`new WebAssembly.Module()`, and WebKit 26 does not apply `'strict-dynamic'` to
module scripts.

It also measures the acceptance authority itself, on the shipped bytes and on
each engine: that the policy Worker instantiates the embedded Lean checker
inside a `blob:` Worker and reports this build's identity; that a fabricated
acceptance record, a bare accepted tree and a replayed record all fail to
commit; that no request for a `.wasm` asset is ever made, which is what keeps
`connect-src 'none'` sufficient; and that a document at the open-node path
bound gets a structured answer and leaves the Worker alive, one node past it
is refused by preprocessing, and a wide, shallow document above the old node
cap is accepted.

The current tests include a regression for a real traversal bug: separate text
nodes could exceed the node limit because only the element branch checked it.
Both normalizers now reject that input.

## Adding a newly discovered exploit

First reproduce the exact failure in the affected layer. Add a regression with
an expected result independent of implementation output, plus a benign example
that must remain useful. Decide whether the fix belongs in parsing, policy,
rendering, runtime isolation, or a dependency update.

For a policy change, update the schema or the two validator implementations,
the relevant catalog explanation, and affected proofs. Run full verification
and browser checks. Review whether the theorem statement covers the new risk;
a proof can keep compiling while an unmodeled exploit remains possible.

Cross-engine agreement cannot detect a shared policy mistake. The independent
safety oracle, known expected outputs, malformed-markup regressions, and browser
tests provide complementary evidence. The current negative controls test the
oracle against representative injected faults; they are not exhaustive mutation
testing or a claim of complete exploit coverage.

## The case for Lean, and its limits

Lean does not give the browser fewer permissions than equivalent JavaScript.
It gives a universal, mechanically checked statement about a small modeled
security boundary. Tests exercise examples; accepted-output theorems quantify
over every finite `Raw` input and every context.

This is valuable when the policy is stable enough to formalize, mistakes have
high cost, and the project can maintain explicit specifications and proofs.
For a small prototype, reviewed JS plus good tests and browser isolation may
be a reasonable tradeoff.

The shipping demos and the CDN entry point now run the Lean checker compiled to
WebAssembly as the acceptance authority, so the proved implementation is what
decides. The JavaScript checker still runs beside it and its candidate must
match exactly; a divergence refuses the document rather than being resolved in
either side's favour.

That is not a proof of JS equivalence, and differential tests never were one.
What changed is which implementation the browser obeys: it is now the one the
theorems are about. What did not change is that everything around it — the
compiler, the FFI, the JSON codec, the glue, the transport, the renderer and
the browser — is outside those theorems.

Parser behavior and resource use, JSON adapters, renderer correctness, message
handling, QuickJS isolation, the code generators and compilers, and browser
semantics remain outside these theorems. In particular, the deep-input adapter
stack overflow is now fixed in JavaScript by bounded iterative preprocessing
(`src/adapters/parse5.js`, limits in `src/policy-protocol.js`, regressions in
`test/preprocess.test.js`); that is tested behavior, not a theorem. The browser
DOMParser resource-loading question is separate parser-hardening work; output
proofs do not fix either of them.
