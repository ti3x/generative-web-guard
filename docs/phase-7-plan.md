# Phase 7 plan — verifying the tool itself

Phases 1–6 established what the guard accepts and proved properties of the
acceptance checker. This phase asks a different question: does the **tool**
behave under interleavings, adversarial volume, resource pressure, and real
host pages the way the design says it does? The evidence today is strong on
policy correctness and thin on three things: message-ordering races, sustained
adversarial load, and the embedding application around the guard.

Status: implementation in progress. Deliverables 1 and 2 are implemented;
the Wasm half of deliverable 3 has found unresolved sustained memory growth.
See the [implementation handoff](phase-7-implementation-plan.md) and
[results](phase7-results.md).
This design document is not verification evidence. Each
item states what exists now, what is missing, the oracle that would catch a
failure, and where the work lands. Results go in a separate
`phase7-results.md` when there are results; this file is not evidence.

Standing rules carry over from [refactor.md](../refactor.md): record actual
passes, failures and skips; a test that passes because the guard deleted
everything is weak evidence; cross-engine agreement cannot detect a shared
error; and a measurement is not a theorem.

## What already exists

| Concern | Current evidence | Gap |
|---|---|---|
| Policy semantics | 238 unit tests, 176 BDD scenarios, red-team corpus, JS/native-Lean differential (323 seeded cases), property runner (336 cases, seeds 1/7/91) | Fixed seeds and structured generators; no mutation fuzzing, no trap oracle |
| Session lifecycle | `frame-port.test.js`, `guard.test.js`, `lean-authority.test.js` cover named scenarios | Interleavings are hand-picked; the Phase 6 attach race was found by reading, not by a test |
| Wasm resources | `wasm-audit.mjs` measures heap break, memory growth and linear stack on single worst cases | No soak: leaks that need repetition are invisible |
| QuickJS confinement | `confinement.test.js`, `runtime.test.js` | Known-escape checks only; no generated hostile programs |
| Browser behaviour | `check:browser` on Chromium/Firefox/WebKit; `spike/csp-variants.mjs` | Round-trip through the browser parser untested; host-page variants are a spike, not a gate |
| Build integrity | Reproducible builds, CI-built Wasm compared with the manifest, token grep of bundles | Token grep, not a sink scan; no mutation testing of the negative controls |

## Deliverables

### 1. Model-based fuzzing of the session state machine

**Threat.** Ordering bugs between host, policy Worker and frame: a request
served before the port exists, a stale generation rendering, a promise that
never settles, a message posted to a dead Worker, or a leaked pending entry.

**What to build.** A randomized scheduler over the existing test doubles
(`test/port-support.js`) driving `createPolicySession` and `createGuard`
with these events in arbitrary interleavings: `preprocess`, `nextGeneration`,
`dispose`, Worker error, `ready`, `checkerReady`, `frameAttached` (early,
late, never), frame `rendered`/`refused`/silence, request timeout, and
Worker replacement. Seeds are logged so a failure replays.

**Invariants checked after every step.**

- Every returned promise settles exactly once, with a status in the documented set.
- `rendered` is settled only after a frame acknowledgement carrying the same request id and generation.
- No message containing a tree is ever delivered to a session that has a frame.
- Nothing is posted to a Worker after `terminate`.
- After `dispose`, pending and awaiting maps are empty, no timers remain, and every Worker double reports `terminated`.
- A superseded generation never renders after a newer one has.

**Lands in.** `test/session-model.test.js` (Node only, no browser), a
small scheduler helper in `test/`, and a nightly CI job with a higher
iteration count than the per-push run.

### 2. Fuzzing the untrusted-input path with a fixed-point and no-trap oracle

**Threat.** Inputs inside the frontend bounds that throw out of the Worker
path, hang, exceed the time or memory budget, or trap the Wasm instance. A
trap is not an acceptance bug, but it poisons the instance and costs
availability for every later document.

**What to build.** A mutation fuzzer seeded from `red-team/corpus.json`,
the differential corpus and the BDD fixtures, plus a grammar generator for
HTML/SVG shapes (unclosed tags, foster parenting, RCDATA, entity floods,
attribute floods, deep and wide nesting up to and just past every
`PREPROCESS_LIMITS` bound). Each case runs `preprocessHtml` →
`buildCandidate` → Lean acceptance through the real `createLeanChecker`
instance in Node.

**Oracles.**

- No exception escapes `handlePolicyRequest`; every outcome is a structured result or refusal.
- Every accepted tree is a fixed point of JS `checkTree` and of native Lean `checkTree` (the existing differential oracle), and passes `isTreeShaped` and the renderer's construction assertions.
- Per-document wall time and heap-break delta stay under a recorded budget.
- The checker never traps for any input the frontend forwards; `checker.poisoned` stays false across the run.
- Benign content in seeded cases survives, using the corpus's recorded "must remain" text.

**Also fuzz the ABI decoder directly.** Structure-aware mutation of the
`check` request JSON (`lean/Guard/Io/Decode.lean` is the Wasm's attack
surface): unknown fields, duplicate keys, wrong types, boundary lengths,
invalid UTF-8 at the shim, nested roots. The oracle is `error` with no tree
and no trap.

**Lands in.** `scripts/fuzz-policy.mjs` with `--seed`, `--iterations` and
`--minutes`; a nightly CI job; a bounded smoke run inside `npm test`.

### 3. Resource soak and leak detection

**Threat.** Memory that grows only under repetition: a missed `lean_dec_ref`
in `lean/wasm/shim.c`, allocator fragmentation in the Lean runtime, or
host-side leaks of Workers, blob URLs, MessagePorts and iframes across
replacement.

**What to build.**

- Extend `scripts/wasm-audit.mjs` with a soak mode: thousands of sequential
  documents of mixed size through one instance, sampling heap break every N
  documents. Oracle: no upward trend after warm-up; no memory growth event.
- A browser soak in `scripts/browser-check.mjs` or a sibling script: trap the
  checker, let the session replace the Worker, render, repeat a few hundred
  times while sampling process RSS the way `phase6-benchmark.mjs` does; also
  count live `blob:` URLs and message listeners on `window` before and after.
- A main-thread budget: a `PerformanceObserver` for long tasks during the
  maximum-size renders, since the structured clone of a 2 MB tree to the
  frame runs on the host thread.

**Lands in.** `wasm-audit.mjs --soak`, `scripts/browser-soak.mjs`, numbers
recorded in `phase7-results.md`.

### 4. Browser round-trip and host-integration matrix

**Threat.** Two classes that break real applications rather than the policy:
the browser's serializer disagreeing with our tree model (mutation XSS), and
host pages whose environment breaks the guard's plumbing.

**Round-trip oracle.** In each engine, render an accepted tree into the
frame, serialize the frame's `#root` back to HTML, parse it with the
production frontend, and rerun acceptance. Anything other than an identical
fixed point is a finding. Run over the red-team corpus and the fuzzer's
accepted outputs.

**Host-integration matrix.** Promote `spike/csp-variants.mjs` into a
permanent gate and extend it with: an existing Trusted Types policy on the
host page, `Content-Security-Policy: sandbox`, nonce-based `script-src`,
COOP and COEP headers, a host that patches `postMessage`, `MessageChannel` or
`Worker` (zone.js-style), the guard running inside an iframe, and two guards
on one page. Oracle: either a working render or a documented startup code;
never a hang, an unhandled rejection, or a change to any global outside the
container.

**Lifecycle hazards to test explicitly.**

- Reparenting the container reloads a `srcdoc` iframe and destroys the port.
  The guard must detect the reload and report a status, or rebind, rather
  than time out every later render.
- `onStatus` or `onEvent` handlers that throw, or that synchronously call
  `render` or `dispose`.
- One hundred concurrent `render` calls, `dispose` during startup, and reuse
  of a container after `dispose`.

**Lands in.** New sections of `scripts/browser-check.mjs`, a
`scripts/host-matrix.mjs` derived from the spike, and the `browser-matrix`
CI job.

### 5. Hostile guest programs for QuickJS

**Threat.** Programs that stay inside the interface but exhaust the memory
cap, the stack, or the interrupt deadline, or that corrupt the serialization
path so the Worker is unusable afterward.

**What to build.** A generator for programs targeting each budget in
`src/runtime/`: string and array growth to the memory limit, recursion to
the stack limit, loops against the interrupt handler, BigInt and regex
blow-ups, `Proxy` and getter tricks on the returned view, and throws during
serialization. Oracle: a bounded structured rejection, `guard.interactive`
false, and a fresh program running normally afterward on the same guard.

**Lands in.** `test/runtime-fuzz.test.js` with a bounded iteration count,
nightly at higher counts.

### 6. Verifying the verification

**Mutation testing.** Run a mutation tool over `src/policy-client.js`,
`src/policy-worker.js`, `src/frame.js`, `src/frame-channel.js` and
`src/render.js`. The repository relies on negative controls; mutation
testing checks that weakening a guard actually fails a test. Record the
surviving mutants and either kill them with a test or explain them.

**Sink scan of shipped bundles.** Replace the token grep in
`scripts/check-cdn.mjs` with an AST scan (acorn is already a dependency) of
`cdn/*.js` for every DOM and code sink: `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write`, `srcdoc` assignment, `setAttribute`
with `on*`, `eval`, `Function`, `importScripts`, dynamic `import()`. An
allowlist names the one permitted site for each, with the file and reason.

**Lands in.** A `check:mutation` script run nightly, and `check:cdn`.

## Order and dependencies

1. Deliverable 1 and the Node half of deliverable 2 first. Both run without
   a browser or Docker, cover the two thinnest areas, and produce seeds that
   make every later failure reproducible.
2. Deliverable 3, because its soak inputs come from the fuzzer's corpus.
3. Deliverable 4, which needs the browser matrix and a served origin.
4. Deliverables 5 and 6 in either order.

## Verification gate for this phase

| Change | Required evidence |
|---|---|
| New Node harnesses | `npm test` stays green; each harness runs a bounded smoke inside it and a long nightly job; seeds recorded on failure |
| Any fix a harness finds | A named regression test at the boundary where it was found, plus the fuzz seed that found it |
| Browser gates | One engine per invocation on Chromium 140, Firefox 141, WebKit 26; passes, failures and skips recorded |
| Bundle changes | `npm run build` twice byte-identical; `npm run check:cdn` |
| Results | `docs/phase7-results.md` with numbers, seeds, engine versions and what was not measured |

## Not in scope

- New policy capabilities or profile changes.
- Raising any `PREPROCESS_LIMITS` or Wasm memory ceiling; fuzzing may justify
  lowering one, never raising one without the measurements Phase 6 required.
- Formal modelling of the message protocol. Deliverable 1 is the practical
  substitute; a TLA+ or Alloy model is a possible follow-up if the fuzzer
  keeps finding ordering bugs.
- CI on push and branch protection, which remain the repository-settings
  task tracked in [phase-6-plan.md](phase-6-plan.md).
