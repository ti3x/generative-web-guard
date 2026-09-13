# Phase 6 handoff — reduce duplicated policy enforcement

A self-contained brief for a focused session. Phases 1–5 are complete,
committed and verified; this is the remaining major work from
[refactor.md](../refactor.md). Read that file's "Phase 6" section and its
"Policy and proof foundation" section first — this document expands them with
the current tree state, the exact obligations, the gate, and the traps.

Phase 6 is a **Lean proof-development** effort, not a plumbing change. Its whole
value is a *smaller, still-proved* acceptance checker plus the safe removal of
duplicated enforcement. Do not rush it: the plan's standing rule is that proofs
and specifications are strengthened or deliberately replaced with documented
obligations, **never weakened just to make verification pass**. If an obligation
cannot be discharged, leave it explicit and open rather than deleting a theorem
or loosening a test.

## Why this phase exists

Today a single render runs the policy twice. On the accepted path the policy
Worker (`src/policy-core.js`) does:

1. `preprocessHtml` → bounded raw tree (`src/adapters/parse5.js`).
2. `checkTree(raw)` in **JavaScript** — the candidate builder / proposal.
3. `checker.check(raw)` — **Lean/Wasm** `Guard.checkTree`, the authority.
4. `sameTree(candidate, lean)` — the two must be identical or the document is
   refused (`authority-mismatch`).
5. `isValidated(lean)` — the host predicate re-checks Lean's tree.

So the JS checker, the Lean checker, and the host predicate all run per render,
and the frame re-validates again on commit. That redundancy was deliberate for
phases 4–5 (it makes a candidate-builder bug visible instead of silently
rendering), but it is duplicated enforcement that Phase 6 removes **after**
proving a smaller checker preserves the guarantees.

`Guard.checkTree` (production authority) is the full checker: it carries an
output-policy postcondition **and a replay** — a second normalization that must
reproduce the tree with no further changes. The plan wants a smaller
`acceptCandidate` that keeps everything replay currently provides, with its own
proofs, before `checkTree` is retired.

## Precondition — the gate is already green

The plan gates removal of the redundant copies on "Phase 4/5 bypass tests still
pass." They do, at the head of this branch:

- `test/lean-authority.test.js` — the six R4 negative controls (Lean rejects a
  benign candidate; module removed / corrupt / stalled; spoofed and replayed
  replies; candidate builder forced to emit a forbidden tree).
- `test/frame-port.test.js`, `test/frame-channel.test.js` — the private-port
  controls (bypass refused, smuggled tree refused, stale/duplicate/foreign
  dropped).
- `test/guard.test.js` — the createGuard lifecycle.

Re-run these first (`node --test test/lean-authority.test.js test/frame-port.test.js test/frame-channel.test.js test/guard.test.js`)
and confirm green **before** deleting anything. If any is red, stop: the
precondition for removal is not met.

## The five deliverables

### 1. Split candidate construction/diagnostics from acceptance
`src/policy-core.js` currently blends "build the JS candidate" with "decide."
Make the JS side explicitly a *proposal and a source of diagnostics* that cannot
declare a document safe. In practice: the candidate builder returns content +
change records; only the Lean authority's verdict authorizes a render. Much of
this framing already exists in the header comments — the code should match it so
that removing the JS *acceptance* (step 4/5 above) is a localized change.

### 2. Implement the smaller Lean `acceptCandidate` checker
Build it from [`lean/Guard/Policy/Accept.lean`](../lean/Guard/Policy/Accept.lean),
but **add everything currently obtained from replay before retiring replay**:

- strict root/node decoding (reuse/extend `lean/Guard/Io/Decode.lean`, which is
  already a total, fuel-bounded strict decoder — do not reintroduce the lenient
  `rawFromJson`);
- exact namespace/name representation;
- unique, sorted attributes;
- canonical validator results;
- required attributes;
- recursive context rules;
- complete size/depth accounting.

Prove its concrete invariants (see "Obligations" below) and **test preserved
behavior against `checkTree` before replacing it**. The plan is explicit: the
current `Accept.lean` predicate **alone is not a drop-in replacement** for
`checkTree`. Any remaining fixed-point property that replay was providing must
be documented and proved separately, not assumed.

### 3. Remove the redundant JS acceptance copies — only after the gate holds
Remove repeated host/frame normalization and the redundant JS `checkTree`
acceptance from the default runtime (steps 4/5 in `src/policy-core.js`, and the
host predicate re-check in `src/host.js`'s `resolveRender`), **only after** the
Phase 4/5 bypass tests above still pass with the change in place. **Keep**
renderer assertions in `src/frame.js` / `src/render.js` that check the
renderer's own construction contract — those verify the renderer, not the
policy, and are not duplication.

### 4. Keep the full normalizer and JS comparison as test tools
Retain the full Lean normalizer and the JS↔Lean comparison as reference/test
tools initially (`scripts/lean-differential.mjs`, `npm run check:lean`, the
`ENGINES=js,lean` property checks). Where the new contracts **intentionally
differ**, stop requiring identical diagnostic change counts — but keep
independent safety, exact benign-output, and agreement tests for shared semantic
behavior. The differential harness is a bug-finder; per the plan's own caveat,
cross-engine agreement cannot detect a shared policy error, so it is never
evidence of correctness on its own.

### 5. Bundle only the candidate checker into the production Wasm
Bundle only `acceptCandidate` and its necessary dependencies into the production
Wasm entry. Then **measure and record before/after** on the supported browser
matrix (Chromium 140.0.7339.186, Firefox 141.0, WebKit 26.0):

- cold start,
- resident / peak memory (`scripts/wasm-audit.mjs` measures linear-memory stack
  and heap break already),
- typical and maximum-size render latency,
- message copies,
- compressed distribution size (the checker is base64-embedded at ~+33%; the
  plan notes gzip-then-base64 as the obvious next step — a `DecompressionStream`
  dependency in the trusted startup path, evaluate but do not assume).

The current embedded checker is 1,707,724 bytes (sha256 `853b2bec…`), recorded
in `cdn/asset-manifest.json`; a smaller checker should shrink both that and the
`policy-worker.min.js` / `full.min.js` payloads. Record the deltas.

## Obligations to prove (from refactor.md "Policy and proof foundation")

Express these as Lean theorems over the new checker, not as restatements of the
profile table:

```
profileValid(p) = true
  -> profile p stays within the reviewed capability set and hard limits

profileValid(p) = true AND acceptCandidate(p, t) = true
  -> conforms(p, t) AND coreInvariants(t)

profileRestricts(p2, p1) AND acceptedBy(p2, t)
  -> permittedBy(p1, t)
```

The third concerns permitted **output trees**; do not infer that tightening a
sanitizer monotonically reduces successful raw-input requests (Phase 3 already
proves `restricts_permits` for `checkTree`; the analogue must hold for
`acceptCandidate`). Strengthen primitive contracts where useful (grammar
membership, canonical form, actual numeric ranges/counts, rejection of
resource-reference syntax in paint values). Do **not** assert browser
noninterference or bounded CPU time from structural or termination proofs.

## Files

- Lean: `lean/Guard/Policy/Accept.lean` (source of the smaller checker),
  `lean/Guard/Policy/Check.lean` (current `checkTree`), `lean/Guard/Io/Decode.lean`
  (strict decoder to reuse), `lean/Guard/Io/Abi.lean` (ABI export — a new
  `acceptCandidate` export goes here), `lean/Guard/Props/*` (proofs),
  `lean/Tests/*` (`#guard` checks).
- Runtime: `src/policy-core.js` (remove steps 4/5), `src/lean-checker.js` /
  `src/lean-abi.js` (bind the new export), `src/host.js` (`resolveRender`
  predicate re-check), `src/policy.js` (JS `checkTree` becomes proposal-only).
- Build/measure: `lean/wasm/build.sh`, `scripts/build.mjs`,
  `scripts/wasm-audit.mjs`, `cdn/asset-manifest.json`, `scripts/check-cdn.mjs`.
- Docs: `docs/VERIFICATION.md`, `README.md`, `refactor.md` (tick Phase 6).

Generated files (`src/policy-data.js`, `src/capabilities-data.js`, Lean tables)
have sources — edit the source and regenerate with `npm run gen:policy` /
`npm run gen:rules`; never hand-edit generated output.

## Verification gate (heaviest row of the plan's table)

Docker is required. Run in the background and poll — the Lean+Wasm build is many
minutes of silent output.

1. `npm test` — full: fresh native Lean + Wasm from the checkout, the axiom
   audit (`npm run check:proofs` should stay at the foundational axioms only —
   `propext`, `Classical.choice`, `Quot.sound`), independent property checks,
   and the differential checks. **No stale local Wasm.**
2. `npm run check:policy`, `npm run check:rules`, `npm run check:properties`,
   `npm run check:lean` — the last must still agree (it is currently 323 cases,
   0 mismatches; the count may change where contracts intentionally differ, but
   a mismatch on shared behavior is a failure).
3. `npm run build` twice → `cdn/` byte-identical; `npm run check:cdn`.
4. `PORT=8096 npm run serve` then `DEMO_URL=http://localhost:8096/ npm run check:browser`
   on all three engines, **one engine per invocation**. Record the before/after
   measurements here.

Exit: one authoritative candidate checker per render, one production parsing
frontend, a small public API, and an explicit written account of exactly what
duplication was removed and what evidence shows the guarantees are preserved.

## Operating notes for a delegated session

- The Lean+Wasm gate and the three-engine browser sweep sit silent for minutes;
  run them with a background job and poll, and split the browser sweep into one
  engine per call, or a stream watchdog may kill a subagent mid-run. (This bit
  the phase-4/5 agents repeatedly.)
- Read large files (`policy-core.js`, the Lean proof files) in ranges, and
  write large files in chunks — do not `cat`/emit whole 50 KB+ files.
- `grep` can silently return nothing on files containing NUL or non-UTF-8 test
  fixtures; use `grep -a`.
- Land work in increments that leave the tree green (`npm run test:js` after
  each), so an interrupted session resumes from verified progress.

## Not Phase 6, but adjacent open items

Tracked separately so they are not forgotten, but they are **not** part of this
phase's scope:

- CI verified on an actual push (the `proofs-and-full-verification` and
  `browser-matrix` jobs exist in `.github/workflows/build.yml` but have never
  run) and branch protection (a repository-settings task).
- The showcase demo (`demo/showcase.js`) still uses the low-level policy
  session; migrating it to `createGuard` is optional (it is a per-sample
  diagnostics editor).
- Profile C (nonce + `'strict-dynamic'`) is documented and verified for CSP
  mechanics in `spike/nonce/`, but not yet against the real ~1.7 MB bundle;
  validating it on the shipped bytes fits naturally with the CI-on-push work.
