# Phase 7 results

Status: implementation in progress. This file contains evidence only; see the
[implementation plan](phase-7-implementation-plan.md) for intended work.

## Planning baseline (2026-09-14)

- `npm run test:js`: passed; native Lean/proof verification intentionally skipped.
- `npm run check:cdn`: passed against existing artifacts.
- `git diff --check`: passed.
- Full verification and browser tests were not run during planning.
- Manual Node probe: matching frame sequence with wrong request/generation
  incorrectly acknowledged. Regression and fix pending.
- jsdom-only probe: adjacent text merges and textarea leading newline loss on
  serialize/reparse. No browser conclusion follows from this probe.

## Completed implementation slice (2026-09-22)

Evidence below was collected from the dirty Phase 7 worktree based on
`b9353a44df28ae39638fc46fd4f2516441f926b8`. The checker binary SHA-256 was
`8171ae736acbcf635a8b2e149179445aed1f8347fdc0ba6e07f1309fb8ec3c56`.

### Deliverable 1: session state machine

- The policy Worker's dispatch is shared with deterministic doubles through
  `src/policy-dispatcher.js`; the production entry still creates the Lean
  authority and exposes no message-installable capability.
- Named regressions cover acknowledgement identity, duplicate readiness,
  disposal and late messages, callback exceptions, checker poisoning, Worker
  replacement and frame reload.
- `node scripts/fuzz-session.mjs --seed=1 --iterations=100`: passed 100 traces
  and 1,984 scheduled operations. The report records the seed and dirty base
  revision; no failure was reduced or persisted.

### Deliverable 2: input and ABI mutation

- `node scripts/fuzz-policy.mjs --seed=1 --iterations=250`: passed 500 cases,
  split between 250 pipeline and 250 raw-ABI mutations. It accepted 222
  pipeline cases and 39 ABI cases; every other outcome was a structured
  rejection, decoder error or shim refusal. The run exported 222 accepted
  fixed-point candidates for later browser and soak work.
- Peak observed heap break was 35,287,040 bytes; the largest per-case increase
  was 12,337,152 bytes. The checker remained available throughout the run.
- The bounded smoke is part of the unit suite. The full verification run also
  checked the existing JS, native Lean and Wasm fixed-point/property oracles.

### Deliverable 3a: Wasm soak finding (open)

- `node scripts/wasm-audit.mjs --soak --seed=1 --iterations=500` failed after
  393 measured calls, following two complete workload warm-ups.
- The post-warm-up baseline was a 63,369,216-byte heap break in 80 MiB of
  linear memory. Samples then reached 71,757,824 bytes at 200 calls and
  80,146,432 bytes at 300 calls. The next maximum-candidate call grew linear
  memory from 80 MiB to 96 MiB, violating the no-growth oracle.
- This is an unresolved availability/resource finding. It is not recorded as
  a passing soak, and deliverable 3a is not complete. The browser soak has not
  started.

The ordinary single-pass audit still measured a 52.43 MiB peak heap break,
80 MiB peak linear memory, 104 bytes of painted linear stack, and no memory
growth during that bounded workload. That result does not override the
sustained-run failure.

## Verification of the completed slice (2026-09-22)

- `npm run test:js`: passed 243 tests with one intentional JS-only Lean skip;
  176 BDD scenarios and 876 steps passed.
- `npm test`: passed after starting Docker Desktop. It rebuilt current Lean and
  Wasm, audited 63 compiled theorems, passed all 244 tests with no skips, all
  176 BDD scenarios and 876 steps, and the JS/native-Lean/Wasm property checks.
- `npm run build` twice: byte-identical committed CDN hashes.
- `npm run check:cdn`: passed against the regenerated artifacts.
- `DEMO_URL=http://localhost:8089/ npm run check:browser`: passed on pinned
  Chromium 140.0.7339.186 (revision 1193), Firefox 141.0 (revision 1490), and
  WebKit 26.0 (revision 2203).
- `git diff --check`: passed.

The browser command verifies the existing integration matrix and the lifecycle
changes in real engines. It is not the unimplemented Phase 7 browser soak,
round-trip oracle or expanded host matrix.

## Remaining work

- Diagnose and resolve or explicitly disposition the D3a sustained Wasm memory
  growth, then obtain a passing 500-document smoke and 10,000-document nightly
  soak.
- Implement D3 browser replacement/RSS/long-task soak.
- Implement D4 browser round trips and the expanded host matrix.
- Implement D5 hostile QuickJS generation and recovery.
- Implement D6 mutation testing and Acorn-based shipped-bundle sink scanning.
