# Phase 7 implementation plan

Approved implementation handoff, 2026-09-14. This document describes work;
[phase7-results.md](phase7-results.md) records actual evidence. The original
[Phase 7 design](phase-7-plan.md) supplies the threat rationale.

## Implementation status (2026-09-22)

- Deliverables 1 and 2 are implemented and verified.
- The Wasm half of deliverable 3 is implemented as a failing oracle: the
  sustained run found post-warm-up heap-break and linear-memory growth. It is
  not complete until the growth is explained and fixed or explicitly
  dispositioned with a justified oracle.
- The browser half of deliverable 3 and deliverables 4 through 6 have not
  started.

This is implementation status, not evidence; command results and measurements
remain in [phase7-results.md](phase7-results.md).

## Decisions and order

1. Save this handoff and establish reproducible seeds and reports.
2. Implement the Node session model, then the Node input/ABI fuzzer.
3. Implement Wasm and browser resource soaks using their workloads.
4. Add browser round trips and the permanent host matrix.
5. Generate hostile QuickJS programs, then test the negative controls and
   scan the shipped bundles' executable ASTs.

Include minimal transport, lifecycle and runtime fixes with named regressions.
No policy changes, raised limits, JS acceptance fallback, release publication,
or repository-settings changes. Formal protocol modelling remains deferred
unless the fuzzer repeatedly finds ordering bugs.

Push jobs target no more than five added minutes. Nightly harness jobs have a
one-hour ceiling, with fuzz campaigns bounded to 45 minutes. Browser jobs run
one pinned engine per invocation. Unsupported measurements are explicit skips,
never passes.

## Existing evidence and gaps

| Concern | Reuse | Gap |
|---|---|---|
| Policy/input | Differential engines and corpus, independent safety assertions, red-team preservation expectations, BDD and ABI fixtures | Mutation campaigns, sustained no-trap checks and raw decoder bytes |
| Lifecycle | Port doubles, guard integration, authority negative controls | Generated schedules, cleanup accounting, acknowledgement identity |
| Resources | Wasm audit and Phase 6 browser benchmarks | Repetition-dependent growth, Worker replacement and responsiveness |
| Browsers | Pinned matrix, CDN integration, startup controls and CSP spikes | Serialization/reparse, host variants, reload and callback re-entrancy |
| QuickJS | Confinement, runtime and serialization tests | Generated attacks on every runtime budget and recovery |
| Verification | Hashes, reproducibility, exports and token checks | Control mutation and AST scans including embedded code |

Do not copy historical test counts without a command and revision. During
planning, test:js, check:cdn and whitespace checks passed; full verification
and browser tests were not run. A manual Node probe found that matching a frame
sequence alone could acknowledge the wrong request/generation. A jsdom probe
found text-node merging and textarea newline loss during serialization; real
browser evidence must establish those independently.

## Deliverables

### 1. Session state machine

**Threat:** premature success, stale rendering, unresolved work and leaks.

**Build:** `test/session-model.test.js` and a seeded scheduler. Exercise the
real policy client, guard and frame channel. Extract the Worker's dispatch
into an internal environment-neutral factory shared with the test doubles,
instead of copying its protocol. Schedule startup, preprocessing, generation
changes, acknowledgements/refusals, silence, timeouts, Worker errors,
replacement and disposal. Preserve FIFO per transport; inject corrupt,
duplicate and stale messages as explicit fault cases.

**Oracle:** every valid operation reaches one terminal outcome after drainage;
rendered follows an acknowledgement matching instance/session/sequence/request/
generation; attached host replies never carry trees; only the private port
delivers trees; nothing posts after termination; older generations never render
after newer ones; disposal empties queues, maps, timers, ports and Workers.
The initial regression must demonstrate the manually found acknowledgement bug
before its fix. Smoke: 100 traces of 100 actions.

### 2. Input and ABI mutation

**Threat:** parser/codec faults, excessive work, invalid acceptance, content
loss and poisoned Wasm instances.

**Build:** `scripts/fuzz-policy.mjs`. Reuse differential, red-team and applicable
BDD seeds and independent assertions. Run handlePolicyRequest and one real
createLeanChecker in an externally supervised Node worker. Generate malformed
HTML/SVG and below/at/above-limit shapes. Keep required benign fixtures and
protected preservation controls separate from arbitrary destructive mutations.

**Oracle:** structured outcomes; no escaped exception, hang or trap; accepted
trees satisfy shape, construction, independent safety and JS fixed-point
checks. Full verification adds the existing native-Lean fixed-point oracle.
Record per-case wall time, heap-break delta, memory and poison state; use the
existing request deadline and compare heap growth with the audit baseline.

Raw ABI mode preserves duplicate keys and invalid UTF-8 as bytes. Guaranteed
malformations must produce decoder errors or shim refusals with no tree or
stale response; valid mutations may accept or reject. Follow ordinary malformed
cases with a benign check. Never write beyond the input staging buffer while
testing invalid lengths. Smoke: 250 pipeline and 250 ABI mutations. Wasm is a
build prerequisite, not a Docker dependency of the standalone campaign.

### 3. Resources and recovery

**Threat:** allocator growth, retained resources and host stalls.

**Build:** extend `scripts/wasm-audit.mjs --soak`; add
`scripts/browser-soak.mjs`, reusing browser pins and RSS sampling. Warm the
whole fixed Wasm workload twice, then require no memory growth or continuing
heap-break increase. Smoke: 500 documents; nightly: 10,000.

Browser smoke has five replacement cycles; nightly has 300 after 20 warmups.
Count Workers, port closure, blob URL revocation, listeners and iframes; sample
browser-descendant RSS with its process-coverage limitations. Trap injection
must be test-only, paired with an uninstrumented assembled-distribution control.

**Oracle:** benign recovery after replacement, no owned resources after
disposal, stable post-warmup memory and host tasks/heartbeat stalls no longer
than 100 ms. Report all long tasks above 50 ms and feature/attribution limits.
Propagate checker-poisoned as a fatal session refusal, settle the triggering
request, terminate other pending work and lazily replace on the next request.
Never retry the failed document automatically.

### 4. Browser round trips and host matrix

**Threat:** browser tree/serialization differences and broken host integration.

**Build:** extend `scripts/browser-check.mjs` and add
`scripts/host-matrix.mjs`. Render accepted seeds through the shipped guard,
inspect the frame DOM, serialize it, reparse with production parse5 and rerun
real Lean acceptance. A test init script captures only the native serialization
getter before frame hardening; production sink protections remain installed.

**Oracle:** exact accepted/tree/DOM comparisons and independent safety checks.
Every mismatch is a finding; new differences fail. Individually reviewed inert
differences need exact fixtures, expected transformations, engines and reasons.
Never waive active elements, dangerous attributes or failed safety assertions.

Promote CSP variants and test host Trusted Types policies, CSP sandbox, nonces,
COOP/COEP, forwarding API wrappers, nested embedding, two guards, reparenting,
throwing/re-entrant callbacks, 100 concurrent renders and container reuse.
Each row has a specific render/warning/startup expectation, not “any failure”.

On iframe reload, report frame-reloaded, settle pending work, release resources
and require guard recreation. Test early disposal through existing frame and
session factories; add no public cancellation API.

### 5. Hostile QuickJS programs

**Threat:** exhaustion or hostile serialization leaves the runtime unusable.

**Build:** `test/runtime-fuzz.test.js` and a supervised worker using the real
QuickJS core and transport. Target memory, stack, load/step/data deadlines,
source/data/event/state/view/diagnostic sizes, BigInt, regex, proxies/getters,
serialization hooks and thrown values.

**Oracle:** intended-boundary rejection with bounded diagnostics, no unbounded
copy/exception/hang, stopped interaction after failure, and a fresh benign
program running on the same guard with a fresh runtime. Require benign controls
and below/above-bound cases where meaningful. Syntax errors do not prove budget
coverage. Keep confinement tests as independent evidence.

### 6. Verify the verification

**Threat:** ineffective negative controls and missed executable sinks.

**Build:** `scripts/check-mutation.mjs` / check:mutation, an Acorn-based local
runner with reviewed mutations of identity, acknowledgement, delivery,
rejection and cleanup controls. Mutate one site at a time in an isolated
temporary checkout; run its relevant existing and generated regressions.

**Oracle:** every designated security-control mutant is killed. Unexplained
survivors fail. Compile errors and infrastructure failures are not kills;
truncated campaigns are incomplete, not passes.

Replace sink token checks in check:cdn with AST analysis of every shipped JS
bundle and embedded frame/Worker payload. Detect DOM/code sinks, computed
constant properties, direct/indirect evaluation and imports. Distinguish reads,
hardening and unrelated write methods. A reviewed allowlist records artifact,
payload, structural site, occurrence count and reason; unknown/stale sites fail.
Scanner controls must demonstrate rejection of unsafe additions. Preserve
hashes, export checks, dependency separation and reproducibility checks.

## Replay, regression and verification gate

CLI campaigns accept --seed, --iterations, --minutes, --replay and --report.
Reports name revision, harness version, seed, case/trace, input, oracle, budgets,
engine and checker hashes. Persist failures before reduction and retain both
original and reduced reproductions. Session replay uses logical identities.

Commit named regressions and fixtures under `test/fixtures/phase7/`; put campaign
output in ignored directories and upload it in CI. Every harness finding needs
a named boundary test and its seed. Identify manual findings honestly.

Keep public acceptance/rendering APIs unchanged, apart from documented
checker-poisoned/frame-reloaded lifecycle refusal codes. Tighten acknowledgement
validation without changing its fields. Test factories must not become CDN
exports or message-installable capabilities.

Wire bounded smoke into npm test; test:js remains explicitly limited. Nightly
jobs use artifacts built from the same checkout. Runtime/transport changes
require JS and real-browser evidence; checker/ABI changes require full npm test.
Regenerate committed CDN output, build twice byte-identically and run check:cdn.
No phase-complete claim until all gates pass and findings are fixed or explicitly
dispositioned. Results list actual commands, seeds, counts, measurements and skips.
