# Phase 6 results — candidate-only acceptance

Implemented against the baseline at `0ea6687`. The original brief is
[phase-6-plan.md](phase-6-plan.md); the API and trust-boundary decisions are in
[phrase6-feedback.md](phrase6-feedback.md). No backward-compatibility layer is
retained for the removed rendering/JavaScript-acceptance APIs.

## What changed

Production now runs bounded parse5 preprocessing, one JavaScript proposal pass,
one Lean candidate-acceptance invocation, and the structured renderer. Only the
tree returned by Lean is sent to the frame's private Worker port. The following
production work is gone:

- JavaScript output-policy and replay acceptance after candidate construction;
- Lean normalization of the original raw input and runtime replay;
- JavaScript candidate/Lean-output equality comparison;
- host and frame full-policy revalidation;
- host-supplied trees through the parent-message render route.

The JavaScript `buildCandidate` result is `proposed`, not `validated`. Its bounded
diagnostics explain normalization but cannot authorize a commit. The full JS and
Lean reference checkers retain their output-policy/replay semantics and remain
available to differential and property tests. There is no JS acceptance fallback.

The main CDN exports no longer include `checkTree`, `isValidated`, or synchronous
`guardHtml`. Frames have no `render` or `clear` method and are inert until a policy
session binds their private port. Parent render messages are refused before and
after binding; clearing uses the accepted empty-document path. Port identities,
sequence/replay defenses, acknowledgement deadlines, structural checks, and
renderer construction assertions remain. The showcase and CDN demo use this same
path; showcase markup previews are bounded diagnostic strings shown as text.

The optional guest-JavaScript AST linter is unchanged: it is authoring diagnostics,
not an acceptance boundary. QuickJS confinement and markup acceptance are distinct.

## Proof and decoding contract

`Guard.Policy.Candidate` combines the output policy with explicit representation
checks: canonical names, nonempty text nodes, unique sorted attributes, canonical
validator results, required control attributes, recursive contexts, and resource
accounting. ABI v2 decodes candidates directly into `Node` without normalization;
unknown namespaces, extra/missing/duplicate fields, nested roots, malformed or
duplicate attributes, and invalid node kinds are refused.

The new theorems establish profile permission, representation, node/text bounds,
descendant checks, sorted/unique attributes, canonical validator results,
capability exclusions for certified profiles, and restriction of permitted output
trees. The default-profile bridge in `Guard.Props.CandidateReplay` proves:

```lean
acceptCandidate defaultProfile ctx tree = true
  → normalizeTree ctx (nodesToRaw tree) = .validated tree []

acceptCandidate defaultProfile ctx tree = true
  → checkTree ctx (nodesToRaw tree) = .validated tree []
```

Thus the reference fixed-point guarantee is proved rather than executed on every
render, and the existing concrete reference safety theorems still apply. The
reference normalizer's loop bodies were extracted into helpers to support the
proof; its output-policy and replay checks were not removed or weakened. The
catalog-backed audit includes the new theorems and accepts only the existing
foundational axioms, not admitted proofs or new policy axioms.

This is not a proof of JS/Lean equivalence or semantic fidelity to the original
HTML. A builder bug that substitutes a different, policy-conforming tree can now
be accepted; an explicit test demonstrates that tradeoff. Unsafe substitutions
are still refused by the real Lean module. The universal converse (every reference
output is candidate-accepted) is not proved; preserved behavior is regression
tested across the shared corpus. Parsing, codecs, C/Emscripten, trusted JS glue,
transport, rendering, QuickJS, and browser behavior remain outside these theorems.

## Production build and bounds

The new `Guard.Wasm` import root reaches 25 Lean modules. The build derives its C
inputs from that import closure and fails if it reaches the broad `Guard` root,
`Guard.Policy.Check`, `Guard.Io.Api`, or `Guard.Props`. The manifest records the
closure and the checker bytes; this is not merely dead-code elimination after
initializing the full reference library.

The measured preprocessing ceilings are unchanged. The Worker also reapplies
`maxRawPathNodes = 1000` to the actual candidate before serialization/Wasm:
unwrapping can flatten a shallow raw tree into too many siblings. Tests cover
the 1000/1001 boundary, refusal before invoking Wasm, and an accepted in-bound
document immediately after that refusal.
Serialized candidates are bounded before the authority call. Startup sealing,
version checks, trap poisoning, and failure refusal remain mandatory.

## Before/after distribution sizes

All numbers are bytes; gzip uses level 9 and Brotli uses Node's default settings.
These are measured compressed file sizes, not a claim about a CDN's configuration.
The final build uses plain base64 embedding, as before.

| Artifact | Raw before → after | Gzip before → after | Brotli before → after |
|---|---:|---:|---:|
| Lean Wasm | 1,707,724 → 1,591,870 | 346,632 → 327,802 | 246,353 → 235,611 |
| Policy Worker | 2,628,310 → 2,449,615 | 584,863 → 550,111 | 423,962 → 403,742 |
| Full bundle | 3,709,558 → 3,492,559 | 996,260 → 947,979 | 707,690 → 684,080 |

Raw reductions are 6.8%, 6.8%, and 5.8%, respectively. The checker SHA-256 changed
from `853b2bec7bf05d278b047bc99a7a8bd27d8766bbb7295fbdee0b766e9ddf1202`
to `8171ae736acbcf635a8b2e149179445aed1f8347fdc0ba6e07f1309fb8ec3c56`.

## Browser measurements

Measured on the same macOS ARM64 machine using Chromium 140.0.7339.186, Firefox
141.0, and WebKit 26.0. Each invocation uses five fresh browser processes. Cold
time includes cross-origin full-bundle import and `createGuard` readiness, not
browser launch. Each process renders each case 12 times; two warmups per case
are excluded, leaving 50 latency samples per case. The near-node-limit input has
4,999 output nodes; the text-limit input has 200,000 UTF-16 code units across ten
paragraphs. These are repeatable workloads, not every possible worst-case input.

Times below are **median / p95 milliseconds**, before → after. With five cold
samples, the reported cold p95 is the largest sample; no confidence interval or
general browser performance guarantee is implied.

| Engine | Cold ready | Typical render | 4,999 nodes | 200,000 text units |
|---|---:|---:|---:|---:|
| Chromium | 118.7 / 128.6 → 108.7 / 119.1 | 0.8 / 1.3 → 0.5 / 1 | 43.4 / 49.3 → 29.2 / 32.3 | 42.8 / 46.4 → 27.2 / 30.9 |
| Firefox | 136 / 145 → 116 / 124 | 2 / 3 → 1 / 2 | 164 / 174 → 126 / 128 | 213 / 219 → 134 / 142 |
| WebKit | 110 / 113 → 104 / 112 | 1 / 2 → 1 / 2 | 40 / 42 → 28 / 30 | 45 / 46 → 28 / 29 |

Aggregate browser-descendant process RSS was sampled every 25 ms. It includes
browser overhead, can miss short peaks, and can miss helpers reparented outside
the launch process tree (particularly WebKit). Do not compare these as total
memory usage across engines. The peak across five runs was:

| Engine | Baseline peak MiB | Final peak MiB |
|---|---:|---:|
| Chromium | 978.8 | 948.3 |
| Firefox | 1006.9 | 910.6 |
| WebKit (limited process coverage) | 108.3 | 107.6 |

Each raw report also records per-process idle and peak samples. Separately,
`scripts/wasm-audit.mjs` measured an 11.30 MiB heap break after initialization,
52.43 MiB peak heap break, 80 MiB linear memory without growth, and 104 bytes of
painted linear-stack use; the peak figures match the baseline. The 128 MiB memory
maximum and 1 MiB linear stack are unchanged. The engine call stack is a separate
bound; these linear-memory figures do not justify raising the path limit.

The audit also sends deliberately oversized candidates directly to the ABI.
For example, the 1,026,082-byte adversarial request was rejected in 85 ms versus
56 ms through the baseline checker. That is not a legal production output or a
claim that every rejection became faster; the Worker applies candidate bounds
before reaching that path.

Final message instrumentation reports, per 36 successful renders: 36 HTML
messages to the Worker, 36 tree messages to the frame, 36 metadata-only rendered
replies to the host, and zero tree messages to the host or back into the Worker.
The default Phase 5 private-port path already used one tree transfer, so its
copy count is unchanged. Migrating the old showcase/CDN host-mediated route
removes its Worker→host→frame double transfer (source-level baseline comparison,
not an instrumented count of those old demos). JS object allocations and the
JSON/Wasm codec copies are not included in these message counts.

Reproduce with a server on port 8096 and one engine at a time:

```sh
PORT=8096 npm run serve
ENGINES=chromium DEMO_URL=http://localhost:8096/ RUN_LABEL=after REPORT_PATH=/tmp/phase6-chromium.json node scripts/phase6-benchmark.mjs
```

Raw reports: [Chromium before](phase6-before-chromium.json) /
[after](phase6-after-chromium.json), [Firefox before](phase6-before-firefox.json) /
[after](phase6-after-firefox.json), [WebKit before](phase6-before-webkit.json) /
[after](phase6-after-webkit.json).

## Gzip-before-base64 experiment: not the default

`GUARD_WASM_EMBEDDING=gzip-base64 npm run build` enables the retained prototype.
It embeds 327,802 compressed checker bytes (437,072 base64 characters), versus
1,591,870 bytes (2,122,496 characters) for plain base64. Decompression is cached,
checks the expected length with a bounded streaming reader, and fails closed on
missing `DecompressionStream`, corrupt data, bad encoding, or length mismatch.
Default builds remain `base64` and do not execute the decompression path.

In the experimental build the Worker was 763,582 raw / 420,121 gzip / 403,788
Brotli bytes; the full bundle was 1,806,464 / 818,465 / 695,007. Gzip transfer
improved, but full-bundle Brotli was slightly worse than the plain-base64
candidate build (684,337 bytes in that comparison).

The initial cold medians for plain candidate → gzip were Chromium 118.6 →
126 ms, Firefox 131 → 98 ms, and WebKit 109 → 58 ms. Repeated gzip batches gave
119 ms in Chromium and 93 ms in Firefox. Firefox peak process-RSS samples were
926.7 and 942.7 MiB in the two gzip batches, above the plain candidate comparison
batch's 910.1 MiB (also above the final plain build's 910.6 MiB). These small,
non-randomized samples do not prove causation, but they do not clear the agreed
no-repeatable-peak-regression gate. Gzip therefore remains opt-in experimental,
not the shipped default; further work needs better memory attribution and
repeated controlled measurements.

Experimental comparison reports: [plain Chromium](phase6-base64-chromium.json),
[Firefox](phase6-base64-firefox.json), [WebKit](phase6-base64-webkit.json);
[gzip Chromium](phase6-gzip-chromium.json), [Firefox](phase6-gzip-firefox.json),
[WebKit](phase6-gzip-webkit.json); repeat [Chromium](phase6-gzip-repeat-chromium.json)
and [Firefox](phase6-gzip-repeat-firefox.json). Each report records its checker
identity/encoding and artifact sizes; prototype and final bundles are not assumed
byte-identical.

## Final verification

The property and differential harnesses compare two independent normalizers:
the JavaScript checker and native Lean's reference `checkTree`. Native Lean also
reports whether each reference output passes `acceptCandidate`, and the harness
fails if it does not. The Wasm engine in `scripts/lib/engines.mjs` is not a
third normalizer: it runs the production path, JS `buildCandidate` followed by
Wasm `acceptCandidate`. Its reported changes and change kinds are the JS
proposal's diagnostics, and a Wasm rejection is summarized as `output-policy`,
so agreement there confirms the pipeline, not independent normalization.

The repository policy/proof and distribution skill gates were followed. Final
results on the working tree:

| Check | Result |
|---|---|
| `npm test` | Passed with fresh native Lean and Wasm builds; 233 unit tests, zero failures/skips; 176 BDD scenarios / 876 steps passed |
| Axiom audit (within `npm test`) | 63 compiled theorems; only `propext`, `Classical.choice`, and `Quot.sound` |
| Independent properties (within `npm test`) | 336 cases / 334 fixed points in JS and in native Lean's reference `checkTree`, which normalize independently; the Wasm engine runs the production path (JS proposal, then `acceptCandidate`) and agreed on the same 336 cases. Unsafe-output and erase/reject-all negative controls passed |
| Generated policy/rules and traceability (within `npm test`) | Current; 46 rules covered |
| `npm run check:lean` | 323 reference-comparison cases, zero mismatches (JS vs native Lean; see note below) |
| `npm run build`, repeated | All committed CDN files, including the manifest, byte-identical across builds |
| `npm run check:cdn` | Passed; eight asset hashes, embedded checker, self-contained payloads, removed APIs, and port-only frame verified |
| `ENGINES=chromium DEMO_URL=http://localhost:8096/ npm run check:browser` | Passed on 140.0.7339.186; 109 assertions |
| `ENGINES=firefox DEMO_URL=http://localhost:8096/ npm run check:browser` | Passed on 141.0; 109 assertions |
| `ENGINES=webkit DEMO_URL=http://localhost:8096/ npm run check:browser` | Passed on 26.0; 110 assertions |
| `node scripts/wasm-audit.mjs` | Completed; memory/stack figures above, no linear-memory growth |
| Documentation/source hygiene | Relative file links and trailing whitespace checked; `git diff --check` passed |

The browser suites exercise the real Worker/opaque frame, parent-message refusal,
private-port duplicate sequence refusal, replacement and limit recovery,
showcase scenarios, cross-origin CDN rendering and interaction, and negative CSP
configurations. Expected refusals in those negative controls are passes, not skips.

An initial final-matrix run exposed a showcase transition hang: a second call to
the supposedly idempotent `policy.start()` replaced a live Worker's resolved
readiness promise. A new unit test reproduced the failure, the promise is now
reused until Worker replacement, and full verification plus the browser matrix
were rerun successfully. The measurements above were refreshed on those final
bundle bytes, not taken from the failed build.

No package publication, push, hosted CI run, or branch-protection change is part
of this implementation. The nonce/strict-dynamic deployment experiment remains
separate; local browser/CDN evidence is not a claim about a published release.
