# Spike: policy-Worker / private-port feasibility

Status: investigation spike pulled forward from Phase 4, first checkbox
("Complete the policy Worker/frame private-port feasibility check with
Chromium, Firefox, and WebKit"). This directory is a throwaway harness. It is
not wired into `npm test`, `package.json`, or CI, and it does not modify any
production file.

Everything below labelled "observed" was produced by running the harness in
this directory. Statements labelled "inferred" are explanations that the
observations are consistent with, not additional measurements.

## Engines and commands

| Engine | Version string reported by Playwright | Binary |
|---|---|---|
| Chromium | `140.0.7339.186` | `~/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app` |
| Firefox | `141.0` | Playwright `firefox-1490` |
| WebKit | `26.0` | Playwright `webkit-2203` |

Driver: `playwright-core` 1.55.0 (existing devDependency). `playwright-core`
pins Chromium revision 1187, which is not in the local cache; the driver falls
back to the newest cached Chromium (1193). Host platform: macOS 24.6.0, arm64.

Reproduction (no package scripts were added, per the spike constraints):

```sh
node spike/serve.mjs                  # host http://localhost:8094, cdn http://127.0.0.1:8095
node spike/run.mjs                    # all engines, all CSP variants -> spike/results/*.json
ENGINES=webkit PAGES=q2 node spike/run.mjs      # one engine / one page
node spike/summarize.mjs              # human-readable dump
node spike/matrix.mjs                 # compact cross-engine matrix
ENGINE=firefox node spike/diag-static-import.mjs   # the worker-src/script-src module-import probe
```

Harness pieces: `serve.mjs` (two origins; the host page's CSP comes from
`?csp64=`, a worker script's own CSP from `?wcsp64=`), `frame-inline.js` +
`frame-inline.css` (frame document, hash-pinned exactly like
`src/host.js buildFrameDocument`), `policy-worker.js`, `worker-probe.js`,
`worker-shim.js`, `worker-cases.js`, `cdn-boot.js` / `cdn-guard.js` (served from
the second origin), `q1/q2/q3` pages, `csp-variants.mjs`, `run.mjs`. Raw
per-engine JSON is in `spike/results/`.

## Answers to the five questions

| # | Question | Chromium 140 | Firefox 141 | WebKit 26 | Verdict |
|---|---|---|---|---|---|
| 1 | Port transfer into an opaque-origin `sandbox="allow-scripts"` frame via one bootstrap `postMessage`; port becomes the sole render route | pass | pass | pass | POSITIVE |
| 2 | Cross-origin CDN module creates both Workers under a restrictive host CSP | pass only via `blob:` or a same-origin shim | same | same | PARTIAL |
| 3 | Wasm compilation inside a Worker | needs `'wasm-unsafe-eval'` where a policy applies | same | policy not enforced for Wasm at all | POSITIVE, engine-divergent |
| 4 | CSP inheritance for the opaque frame and for Workers | frame inherits; `blob:` worker inherits; network worker does not | same | same | POSITIVE, with a security-relevant asymmetry |
| 5 | Frame posts a commit acknowledgement back over its port | pass | pass | pass | POSITIVE |

Question 2 is the only one that is not a clean pass, and the current demo CSP
fails it twice over.

## Question 1 and 5: channel bootstrap and commit acknowledgement (POSITIVE)

Harness: `spike/q1.html` / `q1.js` / `policy-worker.js` / `frame-inline.js`.
Topology exactly as in `refactor.md`: the host creates the policy Worker and one
`MessageChannel`, transfers `port1` to the policy Worker and `port2` into the
frame with a single `{type:"bootstrap", v:1}` `postMessage`, and never renders
anything itself. Rendering is initiated only inside the policy Worker.

Observed identically on all three engines (`spike/results/*.json`, `q1`,
variant `demo-current`; frame state read directly by the driver, not
self-reported by the page):

- Frame origin is `null` (opaque) in all cases.
- `iframe.contentWindow.postMessage(msg, "*", [port])` transfers the port into
  the opaque frame. `targetOrigin` must be `"*"`; there is no origin string that
  matches an opaque origin.
- The frame installed exactly one port (`bootstrapAccepted: 1`) and then
  committed two renders driven from the policy Worker, returning
  `{type:"committed", requestId, generation, nodeCount, domText}` over the port.
  The policy Worker matched each acknowledgement to the exact pending
  request/generation (`matched: true`), round trip 0-1 ms.
- A newer generation committed; an older generation was refused with
  `{type:"stale"}` and did not change the DOM (`portStale: 1`). The plan's
  `render` contract ("resolves `rendered` only after a frame acknowledgement for
  the exact request/generation") is implementable as written, including
  supersession.
- After bootstrap, the parent sent `{type:"render", ..., text:"PARENT-INJECTED"}`
  directly to the frame. Frame counters:
  `parentMessagesAfterBootstrap: 2`, `parentRenderAttemptsAfterBootstrap: 1`,
  `portRenders: 2`. Driver-read frame DOM stayed `accepted-tree-2`. The frame
  reported the refusal back over the port, so the policy Worker can observe
  parent-side injection attempts.
- The parent then sent a second `bootstrap` carrying a fresh `MessagePort`.
  The frame refused it (`bootstrapRejected: 1`) and a render sent by the host
  over that second port produced no reply and no DOM change.
- The frame works under its own `default-src 'none'` policy: `MessageChannel`,
  `MessagePort`, and `postMessage` are not CSP-gated.

Caveat on the sole-route property: it is enforced by the frame's own fixed code
(`e.source !== parent` plus a one-shot port install), not by the platform. The
platform contributions are the opaque origin, the absence of
`allow-same-origin`, and the port's delivery provenance. That is what
`refactor.md` already claims ("delivery provenance, not a mathematical
certificate"), and the spike does not upgrade it.

Residual assumption, not a browser defect: because the bootstrap must use
`targetOrigin: "*"`, the frame must not be navigable to foreign content between
creation and bootstrap. In this topology nothing untrusted ever runs in the
frame, so the assumption holds, but it should be written down.

## Question 2: CDN-created Workers (PARTIAL - the current demo CSP is not sufficient)

Harness: `spike/q2.html` / `q2.js`, with the Worker matrix in
`worker-cases.js` executed from `http://127.0.0.1:8095/cdn-boot.js`, i.e. by a
module whose own URL is the cross-origin CDN.

### The current demo CSP fails, for two independent reasons

Quoted from `scripts/serve.mjs` (hashes elided):

```
default-src 'self'; script-src 'self' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self'; connect-src 'none'; img-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'
```

Observed on all three engines:

- `import("http://127.0.0.1:8095/cdn-boot.js")` is blocked. All three engines
  report the violation with `effectiveDirective: "script-src-elem"`,
  `blockedURI: "http://127.0.0.1:8095/cdn-boot.js"`. Nothing downstream runs.
- Independently, `worker-src 'self'` blocks `blob:` Workers
  (`effectiveDirective: "worker-src"`, `blockedURI: "blob"`).
- `'wasm-unsafe-eval'` is absent, so Wasm compilation in the host page and in
  any `blob:` Worker is refused on Chromium and Firefox (both report
  `effectiveDirective: "script-src"`, `blockedURI: "wasm-eval"`). WebKit
  reported no Wasm violation and compiled anyway - see N5.

So the plan's instruction "do not assume the current demo CSP is sufficient" is
correct: it is not, and the failure is not marginal.

### Structural limit: a CDN cannot host the Worker script

`new Worker("http://127.0.0.1:8095/worker-probe.js")` and the same with
`{type:"module"}` failed on every engine under **every** CSP variant, including
no CSP at all:

- Chromium: synchronous `SecurityError: Failed to construct 'Worker': Script at
  '...' cannot be accessed from origin 'http://localhost:8094'.`
- Firefox and WebKit: an asynchronous `error` event, no message.

This is not CSP-tunable. Inferred: the HTML `Worker` constructor fetches a
dedicated worker's script with same-origin mode
(https://html.spec.whatwg.org/multipage/workers.html#dom-worker), so no CSP
relaxation can make a cross-origin worker URL work. Consequence for the plan:
the CDN distribution must either carry the Worker payload as source inside the
bundle (`blob:` Worker) or require the consumer to host a same-origin shim file.

### Two approaches that do work

Both were verified end to end in `spike/q3.html` (`?mode=blob` / `?mode=shim`),
where the cross-origin CDN module creates the QuickJS-stand-in Worker, the
policy Worker, and the frame, wires the channel, and completes an acknowledged
render. On all three engines, under the candidate production CSP below, the full
round trip committed in 25-30 ms and the host's direct render attempt was
refused by the frame.

**(a) `blob:` Worker that dynamically imports the CDN payload.** Requires
`blob:` in the applicable worker source directive. Inherits the host document's
policy, so it is CSP-contained.

**(b) Same-origin module-worker shim** (`spike/worker-shim.js`) that imports the
CDN payload URL passed through the `Worker` `name` option. Works under
`worker-src 'self'` with no `blob:`. It is **not** CSP-contained: see Q4.

`data:` Workers are unusable: blocked (`effectiveDirective: "worker-src"`,
`blockedURI: "data"`) under every variant that had any applicable directive, on
all three engines. They only worked with no CSP header at all.

### Directive fallback chain, observed

`blob:` Workers were created successfully when `blob:` appeared in `worker-src`,
or in `child-src` with no `worker-src`, or in `default-src` with neither
present. They were blocked when the applicable directive existed but omitted
`blob:` (for example `script-src 'self' <cdn> 'wasm-unsafe-eval'` with no
`worker-src`/`child-src`). This matches the CSP3 `worker-src` fallback order and
means a host cannot get `blob:` Workers "for free" by omitting `worker-src`.

### Static versus dynamic import inside a module Worker (a real trap)

Isolated in `spike/diag-static-import.mjs`. Identical on Chromium 140, Firefox
141 and WebKit 26:

| Worker body | Needs the CDN origin in |
|---|---|
| `import "https://cdn/payload.js";` (static, top level) | **`worker-src`** |
| `await import("https://cdn/payload.js");` (dynamic) | **`script-src`** |

Decisive pair, both with `worker-src 'self' blob:` and `blob:` allowed:

```
default-src 'none'; script-src 'self' <cdn> blob:; worker-src 'self' blob: <cdn>; connect-src <cdn>
   -> static import OK, dynamic import OK
default-src 'none'; script-src 'self' blob:; worker-src 'self' blob: <cdn>; connect-src <cdn>
   -> static import OK, dynamic import BLOCKED ("Failed to fetch dynamically imported module")
default-src 'none'; script-src 'self' <cdn> blob:; worker-src 'self' blob:; connect-src <cdn>
   -> static import BLOCKED (opaque error event, no violation report), dynamic import OK
```

Inferred explanation, consistent with the spec: HTML fetches a module worker's
script graph with destination `worker` and passes that destination down to the
static descendants, so CSP maps those requests to `worker-src`; `import()` is
fetched with destination `script`, which maps to `script-src`
(https://www.w3.org/TR/CSP3/#directive-script-src). Practical consequence: the
build must not emit a static cross-origin `import` in a Worker entry, or the
host CSP has to list the CDN origin in `worker-src` too. Note that the static
failure produced **no** `securitypolicyviolation` report on any engine - only an
opaque `error` event on the `Worker` object.

## Question 3: Wasm initialization (POSITIVE, engine-divergent)

Probe: `new WebAssembly.Module(bytes)`, `WebAssembly.compile(bytes)` and
`WebAssembly.compileStreaming(fetch(...))` over an 8-byte empty module.

Observed:

- Chromium 140 and Firefox 141 refuse all three forms unless the *compiling
  realm's* policy allows it. The minimal token is `'wasm-unsafe-eval'` in
  `script-src`. Chromium's message: `CompileError: WebAssembly.Module():
  Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is
  not an allowed source of script ...`; reported violation
  `effectiveDirective: "script-src"`, `blockedURI: "wasm-eval"`.
- `'unsafe-eval'` also enables Wasm on all three engines. It must not be used:
  it re-enables `eval`/`new Function`, which `refactor.md` forbids.
  `'wasm-unsafe-eval'` alone leaves `eval` and `new Function` blocked -
  confirmed on all three engines.
- `connect-src` must allow the origin serving the `.wasm` file if the checker is
  fetched rather than embedded. With `connect-src 'none'`, `fetch` failed and
  `compileStreaming` failed with it, while `new WebAssembly.Module(embeddedBytes)`
  still succeeded once `'wasm-unsafe-eval'` was present. The current QuickJS
  dependency (`@jitl/quickjs-singlefile-browser-release-sync`) embeds its
  binary, so it needs `'wasm-unsafe-eval'` but not `connect-src`; a Lean
  checker shipped as a separate `.wasm` file would need both.
- **WebKit 26 does not enforce any CSP restriction on Wasm compilation.** Wasm
  compiled successfully in every configuration tested, including a Worker whose
  own response policy was `default-src 'none'; script-src 'none'; connect-src
  'none'`, and including the host page under `script-src 'self'`. `eval` and
  `new Function` *were* blocked in those same realms, so this is specific to
  Wasm. Cost: we cannot claim "CSP prevents Wasm compilation" on Safari. It does
  not block the plan - it makes WebKit more permissive, not less.

Where the Wasm actually needs to run decides which policy must carry the token:

| Compiling realm | Policy that governs it | Needs `'wasm-unsafe-eval'` there |
|---|---|---|
| Host page | host document CSP | yes (Chromium, Firefox) |
| `blob:` Worker | inherited host document CSP | yes (Chromium, Firefox) |
| Same-origin network Worker with no CSP response header | none | no - nothing is enforced |
| Same-origin network Worker with a CSP response header | that header | yes (Chromium, Firefox) |

## Question 4: CSP inheritance (POSITIVE, with a security-relevant asymmetry)

Observed on all three engines.

**Opaque-origin `srcdoc` frame: inherits the full embedding policy.** Proven
negatively. With the host policy reduced to `script-src 'self'` (frame script
hash removed), the frame's inline script was refused on all three engines and
the frame never came up: `frameAlive: {timeout}`, frame `#root` empty, no
bootstrap, every render timed out. The comment in `src/host.js` is therefore
correct and is now backed by a cross-engine result. Same for the style hash:
removing `'sha256-<frameStyle>'` blocked the frame stylesheet, but the script
still ran and rendering still worked - a missing style hash degrades appearance,
not function.

**`frame-src` does not apply to this frame.** With `frame-src 'none'` in the
host policy the `srcdoc` frame still loaded, bootstrapped, and rendered on all
three engines. Inferred: `about:srcdoc` is a local scheme that inherits its
creator instead of going through a navigation fetch. The `frame-src 'self'
about:` token in the demo CSP is therefore doing nothing for this frame, and
`frame-src` cannot be used as a containment control for it.

**`blob:` Workers inherit the creating document's policy.** Under
`script-src 'self' <cdn>; connect-src 'none'` (no `'wasm-unsafe-eval'`), a
`blob:` Worker reported Wasm `CompileError`, `eval`/`new Function` `EvalError`
and `fetch` failure - the same restrictions as the page. Under the candidate
production policy with `connect-src <cdn>`, the same Worker fetched the CDN
`.wasm` (status 200) and compiled it.

**Same-origin network Workers do NOT inherit the document's policy.** Under
that same restrictive document policy, `new Worker("/worker-probe.js")` reported
`wasmSync: ok`, `wasmAsync: ok`, `newFunction: ok`, `eval` result `2`, and a
successful cross-origin `fetch` to the CDN origin. A Worker's policy comes from
its own response's headers. Two consequences:

- The plan's Workers are **not** CSP-contained by default. Choosing the
  same-origin shim approach silently removes CSP as a layer around the policy
  Worker and the QuickJS Worker, including re-enabling `eval` and arbitrary
  `fetch` inside them. That is a containment regression the plan should record
  explicitly, not a convenience.
- It can be fixed only by serving a CSP response header on the Worker script.
  Verified working minimum for a Worker that must compile Wasm but must not
  evaluate JavaScript strings (`?wcsp64=` route, all three engines):
  `wasmSync/wasmAsync` ok, `fetch` and `compileStreaming` ok,
  `new Function` and `eval` blocked (Chromium, Firefox; WebKit blocks
  `eval`/`new Function` and permits Wasm as described above).
- Also observed: a Worker's own response policy never blocks the Worker's own
  top-level script. With `script-src 'none'` on the Worker response, the Worker
  script still executed on all three engines; only its subsequent
  evaluations/fetches were restricted.

**Nested Workers** are governed by the creating Worker's policy: a `blob:`
nested Worker succeeded from an unconstrained Worker and from a `blob:` Worker
under `worker-src 'self' blob:`, and failed from a Worker whose own response
policy was `default-src 'none'`.

**Trusted Types**, since it appears in the frame policy: Firefox 141 logs
`Content-Security-Policy: Couldn't process unknown directive
'require-trusted-types-for'` and the same for `trusted-types`, and
`typeof window.trustedTypes` inside the frame is `undefined`. Chromium 140 and
WebKit 26 both support it (`trustedTypes` present). So the frame's Trusted Types
layer is a Chromium/WebKit-only defence and the JS sink hardening in
`src/frame.js` is the only equivalent on Firefox. This belongs in the browser
matrix before any claim that Trusted Types protects the frame "in browsers".

## Exact minimum CSP directives

Two deployment profiles were verified end to end. Both are quoted as directive
text; `<cdn>` is the library origin, `<frameScript>`/`<frameStyle>` are the
build's frame script and stylesheet sha256 values.

### Profile A - `blob:` Workers (recommended)

Host document response header:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src <cdn>; object-src 'none'; base-uri 'none'; form-action 'none'
```

Per-token justification, each observed:

- `script-src ... <cdn>` - required for the host page to `import` the CDN
  module, and for a `blob:` Worker to `await import()` the CDN payload.
- `script-src ... 'wasm-unsafe-eval'` - required for Wasm inside the `blob:`
  Worker (which inherits this policy) on Chromium and Firefox.
- `script-src ... 'sha256-<frameScript>'` and `style-src ... 'sha256-<frameStyle>'`
  - required because the `srcdoc` frame inherits this policy.
- `worker-src 'self' blob:` - `blob:` required for the Workers; `'self'` only if
  a same-origin worker file is also used. `child-src` or `default-src` may carry
  `blob:` instead, but whichever directive applies must contain it.
- `connect-src <cdn>` - only if a `.wasm` or other asset is fetched at runtime.
  Omit if every binary is embedded in the bundle.
- `frame-src` - not needed for the `srcdoc` frame (not enforced for it).
- No `'unsafe-eval'`, no `'unsafe-inline'`, no `allow-same-origin`: the
  end-to-end path committed renders on all three engines without them.

Frame document policy: unchanged from `src/host.js`, verified working under
Profile A on all three engines:

```
default-src 'none'; script-src 'sha256-<frameScript>'; style-src 'sha256-<frameStyle>'; require-trusted-types-for 'script'; trusted-types 'none'; base-uri 'none'; form-action 'none'
```

### Profile B - same-origin shim Worker (for hosts that will not allow `blob:`)

Host document response header:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Plus, mandatory for containment, on the **shim Worker script response**:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'wasm-unsafe-eval'; connect-src <cdn>
```

Profile B does not need `'wasm-unsafe-eval'` or `blob:` in the document policy,
which is a genuine advantage for strict hosts. It costs an extra same-origin
file that the consumer must host, and if the second header is omitted the Worker
runs with no policy at all.

## Negative and partial results, and what they cost the plan

- **N1 (partial, Q2): the current demo CSP cannot load a cross-origin CDN
  module or create the Workers.** Cost: `scripts/serve.mjs` and the README/CDN
  documentation need the Profile A policy before Phase 5's "cross-origin CDN
  imports with restrictive host CSP" test can pass. Not a design problem.
- **N2 (negative, structural): a Worker script cannot be loaded from the CDN
  origin.** No CSP makes it work, on any engine. Cost: the build must emit a
  self-contained Worker payload usable from a `blob:` URL, or the distribution
  must ship a same-origin shim the consumer hosts. This is a Phase 4/5 build
  requirement, and it is the single most likely thing to be discovered late.
- **N3 (negative, trap): a static top-level `import` of the CDN payload inside a
  module Worker is checked against `worker-src`, not `script-src`, on all three
  engines, and fails with no violation report.** Cost: the Worker entry must
  bundle its payload or use `await import()`. If a future bundler emits a static
  import, the failure will look like an unexplained dead Worker.
- **N4 (negative, security): same-origin network Workers do not inherit the
  document CSP.** Cost: Profile B's policy Worker and QuickJS Worker have
  `eval`, `new Function` and unrestricted `fetch` unless the host sets a CSP
  header on the Worker response. This does not create a route from guest code to
  host powers by itself, but it removes a defence in depth layer the project
  currently implies exists. Profile A is preferable for that reason.
- **N5 (partial, Q3): WebKit 26 does not enforce CSP for Wasm compilation.**
  Cost: a claim limit only. Any statement of the form "the policy prevents Wasm
  compilation" must exclude WebKit.
- **N6 (partial, Q4): Firefox 141 does not implement
  `require-trusted-types-for` / `trusted-types`.** Cost: the frame's Trusted
  Types layer must be documented as Chromium/WebKit-only in the browser matrix.
- **N7 (minor, Q4): `frame-src 'none'` does not block the `srcdoc` frame.**
  Cost: `frame-src 'self' about:` in the demo CSP is inert for this frame and
  should not be presented as a control.
- **N8 (observability gap, feeds the "actionable startup error"): a CSP failure
  inside the frame is invisible to the host.** When the host policy omitted the
  frame script hash, the host document received **no** `securitypolicyviolation`
  event on any engine (the violation belongs to the frame's document, and the
  frame's script never ran, so it cannot report either). The only signal is the
  bootstrap timeout. Cost: the plan's startup error for this case must be
  timeout-driven and must name the likely cause itself.

Nothing in the spike required loosening the frame's policy, enabling arbitrary
JavaScript evaluation, or restoring same-origin access. The only token added
beyond the existing frame policy is `'wasm-unsafe-eval'`, which is specifically
not arbitrary JavaScript evaluation and was confirmed to leave `eval` and
`new Function` blocked on all three engines.

## Startup errors that must be surfaced

Each row was produced by an actual failing configuration in this spike. The
"host-visible signal" column records what the host can actually detect.

| Unsupported configuration | Host-visible signal | Suggested error |
|---|---|---|
| Host `script-src` omits the CDN origin | the dynamic `import` rejects; `securitypolicyviolation` with `effectiveDirective: script-src-elem` | `csp-cdn-script-src`: name the origin that must be allowed |
| Host `worker-src`/`child-src`/`script-src` omits `blob:` (Profile A) | `securitypolicyviolation` `worker-src` / `blockedURI: blob`, plus a Worker `error` event | `csp-worker-blob`: quote the required directive; offer Profile B |
| Host `script-src` omits `'wasm-unsafe-eval'` and Wasm runs in a `blob:` Worker | `CompileError` inside the Worker, reportable to the host over its port | `csp-wasm-unsafe-eval` |
| Host `connect-src` forbids the checker asset origin | `fetch`/`compileStreaming` rejection inside the Worker | `csp-connect-src` |
| Host `script-src` omits the frame script hash | **none** - only a bootstrap timeout | `frame-bootstrap-timeout`, whose message must list the two required hashes; do not claim a more precise cause |
| Host `style-src` omits the frame style hash | frame works, unstyled; frame-side violation not visible to the host | warn, do not fail |
| Cross-origin Worker URL used | Chromium throws `SecurityError` synchronously; Firefox/WebKit fire an opaque `error` event | build-time defect, not a runtime configuration error |
| Static cross-origin `import` in a Worker entry | opaque `error` event, no violation report | build-time defect; assert against it in CI |

Note that three of these are only distinguishable as "the Worker or frame never
became ready". The startup path therefore needs per-stage timeouts with distinct
codes (frame alive, port installed, frame ready, checker ready) rather than one
aggregate timeout, or the error will not be actionable.

## Recommendation

**The plan's policy-Worker / private-port topology is viable as written.** The
decisive evidence is `spike/q3.html`: on Chromium 140, Firefox 141 and WebKit
26, a module loaded from a cross-origin CDN created both Workers and the
opaque-origin `sandbox="allow-scripts"` frame, transferred opposite ends of one
`MessageChannel` to the policy Worker and the frame, compiled Wasm in the policy
Worker, and completed an acknowledged render in 25-30 ms, while the host's own
direct render attempt was refused by the frame. No part of that required
loosening the frame.

Adopt with the following, all of which are documentation and build work rather
than design changes:

1. Ship Profile A as the documented host CSP and fix `scripts/serve.mjs`
   accordingly (a Phase 4/5 task - deliberately not done here).
2. Treat Profile B as the documented fallback for hosts that refuse `blob:`,
   and document that it requires a CSP header on the shim Worker response or the
   Worker is uncontained.
3. Make the Worker payload self-contained or dynamically imported. Add a CI
   assertion that no Worker entry contains a static cross-origin `import`.
4. Record the browser matrix with its two real divergences: Wasm CSP is not
   enforced on WebKit, and Trusted Types does not exist on Firefox 141.
5. Implement per-stage startup timeouts with distinct codes, because the frame's
   CSP failure is not otherwise observable.

## Not tested (gaps a reader should not assume were covered)

- `'strict-dynamic'` and nonce-based host policies. Only hash and source-list
  policies were tested. `'strict-dynamic'` is a common production pattern and
  changes both script loading and, potentially, hash inheritance into the frame.
  **This is the highest-value remaining gap.**
- Real QuickJS and real Lean/Wasm modules. The Wasm probe compiled an 8-byte
  empty module; it establishes the CSP requirement, not memory ceilings, cold
  start, or growth behaviour (Phase 4's audit of the 64 MB / 16 MB defaults).
- Real Safari, real Chrome, and mobile engines. WebKit 26 and Chromium 140 via
  Playwright are proxies, and Playwright pins Chromium 1187 while the local
  cache provided 1193.
- CSP `report-only` mode, `Content-Security-Policy` delivered by `<meta>` on the
  host, COOP/COEP, `SharedArrayBuffer`, and service workers.
- Teardown semantics: `port.close()`, `Worker.terminate()` races, late messages
  after dispose, repeated create/destroy. Q1 covers supersession only.
- Message size limits, transfer cost for large trees, and any performance
  characterisation beyond the 25-30 ms round trip of a one-node tree.
- Hostile markup, the real candidate builder, and the real renderer. This spike
  rendered a single text node; it says nothing about policy correctness.
