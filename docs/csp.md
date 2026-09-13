# Host Content-Security-Policy and the tested browser matrix

This document is the deployment contract for the host page's CSP. It records
what was measured, on which exact engine builds, and what is deliberately not
claimed. The evidence behind it is the browser feasibility spike
([spike/policy-worker-feasibility.md](../spike/policy-worker-feasibility.md))
plus `npm run check:browser`, which re-measures the load-bearing parts on every
run.

**Profile A is the adopted profile.** Profile B exists only for hosts that will
not allow `blob:`, and it costs a containment layer — see
[Profile B](#profile-b--same-origin-shim-worker-not-the-default).

## Profile A (adopted)

Send this on the **host document** response:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src <cdn>; object-src 'none'; base-uri 'none'; form-action 'none'
```

`<cdn>` is the origin serving the library bundle. `<frameScript>` and
`<frameStyle>` are this build's `scriptHash` and `cssHash` from
`dist/frame-manifest.json`. `scripts/serve.mjs` emits exactly this policy for
the demo (with `connect-src 'none'`, see below); `hostCsp()` there is the
reference implementation.

The **frame document** policy is unchanged and is set by `src/host.js`, not by
the host:

```
default-src 'none'; script-src 'sha256-<frameScript>'; style-src 'sha256-<frameStyle>'; require-trusted-types-for 'script'; trusted-types 'none'; base-uri 'none'; form-action 'none'
```

### Why each token is there

| Token | Why it is required |
|---|---|
| `default-src 'none'` | Everything is denied unless listed below. |
| `script-src 'self'` | The host page's own modules. **Ignored** if the host policy also contains `'strict-dynamic'` (CSP3 §strict-dynamic). Such hosts must use [Profile C](#profile-c--nonce--strict-dynamic-hosts). |
| `script-src <cdn>` | The host page dynamically imports the library from the CDN origin, and any runtime import inside a Worker would also be checked here. Without it the import is refused with `effectiveDirective: script-src-elem`. This token is also **ignored** under `'strict-dynamic'`; Firefox says so out loud (`Ignoring "'self'" within script-src: 'strict-dynamic' specified`, and the same for the origin). For those hosts the fix is a `nonce` attribute on the tag that loads the library, not an origin in `script-src`, and `demo/cdn.html`'s non-nonce'd `<script type="module" src="/dist/cdn.js">` is refused outright on Chromium and Firefox. See [Profile C](#profile-c--nonce--strict-dynamic-hosts). |
| `script-src 'wasm-unsafe-eval'` | QuickJS instantiates Wasm inside a `blob:` Worker, and a `blob:` Worker **inherits this document's policy**. `WebAssembly.instantiate` — the form the bundled QuickJS actually uses — is refused without this token on **all three** engines. |
| `script-src 'sha256-<frameScript>'` | The `srcdoc` frame inherits this policy, and its inline bootstrap script is hash-pinned. Without it the frame never starts, and **nothing reports why**. |
| `style-src 'self' 'sha256-<frameStyle>'` | Same inheritance, for the frame's inline stylesheet. Missing it degrades appearance only. |
| `worker-src 'self' blob:` | `blob:` is required for both Worker payloads. `'self'` is only needed if the host also runs a same-origin worker file; it can be dropped otherwise. |
| `connect-src <cdn>` | **Only** if a `.wasm` or other asset is fetched at runtime. Nothing this library ships fetches one: the QuickJS binary and, since the Lean checker became the acceptance authority, the checker binary too are both embedded in the Worker payloads, so the adopted policy is `connect-src 'none'`. `npm run check:browser` asserts on every engine that no request for a `.wasm` asset is ever made. Widen this only if you ship a separate `.wasm` yourself. |
| `object-src`, `base-uri`, `form-action` `'none'` | Ordinary hardening; nothing in the library needs them. |

### What is deliberately **not** in Profile A

- **No `'unsafe-eval'`.** `'wasm-unsafe-eval'` is not the same token.
  `npm run check:browser` measures, on each engine, that `eval` and
  `new Function` are still refused inside the `blob:` Worker under Profile A.
- **No `'unsafe-inline'`.** The demo has no inline script or style outside the
  hash-pinned frame document.
- **No `allow-same-origin` on the frame.** The frame keeps
  `sandbox="allow-scripts"` and an opaque origin.
- **No `frame-src`.** It is *not enforced* for a `srcdoc` frame: with
  `frame-src 'none'` in the host policy the frame still loaded, bootstrapped
  and rendered on all three engines, because `about:srcdoc` inherits its
  creator rather than going through a navigation fetch. The old demo policy's
  `frame-src 'self' about:` was inert and has been removed rather than left
  looking like a control. Containment at that boundary comes from the opaque
  origin, the absence of `allow-same-origin`, and the frame's own policy.

## Why the Worker payload is a self-contained `blob:`

Two independent findings force this, and neither is CSP-tunable.

1. **A Worker cannot be loaded from the CDN origin. Ever.**
   `new Worker("https://cdn/worker.js")` failed on Chromium, Firefox and
   WebKit under **every** CSP variant tested *including no CSP at all* —
   Chromium throws `SecurityError` synchronously, Firefox and WebKit fire an
   opaque `error` event. The HTML `Worker` constructor fetches a dedicated
   worker's script in same-origin mode. So the payload has to travel inside
   the module. `scripts/check-cdn.mjs` asserts the shipped full bundle never
   constructs a `Worker` from a literal URL.

2. **A `blob:` Worker inherits the document CSP; a same-origin network Worker
   does not.** This is the reason Profile A was chosen. See Profile B below.

There is a third trap the build guards against:

3. **A static top-level `import` inside a module Worker is checked against
   `worker-src`, not `script-src`, and fails with no violation report.**
   Observed identically on all three engines. `await import()` is checked
   against `script-src`. The shipped payloads are self-contained IIFE bundles
   with no import at all; `scripts/build.mjs` and `scripts/check-cdn.mjs` both
   assert that. If a payload ever did need a runtime import it must use
   `await import()`, never a static one, because the static failure looks like
   an unexplained dead Worker.

## Profile C — nonce + `'strict-dynamic'` hosts

**Nonce hosts are supported, but only with a markup change, and Profile A's
`script-src` host-source tokens are inert for them.** This is Profile A with
`'self' <cdn>` in `script-src` replaced by `'nonce-…' 'strict-dynamic'`.
Everything else is unchanged and still required: both hashes,
`'wasm-unsafe-eval'`, and `worker-src … blob:`.

Evidence: [spike/nonce/nonce-strict-dynamic-feasibility.md](../spike/nonce/nonce-strict-dynamic-feasibility.md),
measured end to end (cross-origin module → `blob:` policy Worker → opaque frame
→ private port → Wasm → acknowledged render, 25–30 ms) on Chromium
140.0.7339.186, Firefox 141.0 and WebKit 26.0 with `browser.version()`
asserted.

```
Content-Security-Policy: default-src 'none'; script-src 'nonce-<per-response>' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

The markup that loads the library **must carry that nonce**:

```html
<script type="module" nonce="<per-response>"
        src="https://<cdn>/generative-web-guard.full.min.js"></script>
```

| Token | Why |
|---|---|
| `script-src 'nonce-<per-response>'` | The only thing that makes the library's `<script>` tag load. Under `'strict-dynamic'` neither `'self'` nor the CDN host-source can. Observed: with `script-src 'self' <cdn> 'nonce-X' 'strict-dynamic'` and the nonce removed from the tag, the library's module **did not run** on Chromium or Firefox. |
| `script-src 'strict-dynamic'` | Not required by the library; it is what the *host* already has. Keeping it costs nothing — everything the library does still works. |
| `script-src 'wasm-unsafe-eval'` | Still required and still effective next to `'strict-dynamic'`. Removing it refused `WebAssembly.instantiate` inside the `blob:` Worker on all three engines. |
| `script-src 'sha256-<frameScript>'` | **Hashes survive `'strict-dynamic'`.** With the hash present the `srcdoc` frame bootstrapped and committed renders on all three engines; with it removed the frame was dead and nothing reported why. |
| `style-src 'self' 'sha256-<frameStyle>'` | Same inheritance. Removing it left the frame working but unstyled on all three engines. |
| `worker-src 'self' blob:` | Still required; `'strict-dynamic'` in `script-src` does not change Worker creation. With `worker-src 'self'`, both `blob:` Workers were refused on all three engines. |
| `connect-src 'none'` | Nothing is fetched at runtime. Unchanged from Profile A. |
| `default-src 'none'`, `object-src`, `base-uri`, `form-action` | Unchanged hardening. |

### The failure a modern-CSP consumer actually gets

The policy Google's CSP Evaluator recommends, and that Rails/Django/Next-style
generators emit, is

```
script-src 'nonce-<per-response>' 'strict-dynamic' https: 'unsafe-inline'; object-src 'none'; base-uri 'none'
```

and a consumer on it gets a library that **half-starts and then hangs**. With
the library loaded from a nonce'd tag, the cross-origin module imported fine,
the `blob:` policy Worker was created and its port installed, and then, on all
three engines:

- the `srcdoc` frame **never started** — there is no frame script hash in that
  policy, and `'unsafe-inline'` is ignored because a nonce is present; and
- Wasm was refused for want of `'wasm-unsafe-eval'`, so the Lean checker could
  not start either, which means nothing can be accepted at all.

There is **no `securitypolicyviolation` event anywhere in the host document**
for the frame failure on any engine. The only trace is a console message logged
against `about:srcdoc`, which no host code can read. So the first spike's N8 is
not merely preserved under nonce policies — it becomes the *default* experience
of a modern-CSP consumer. That is why `frame-bootstrap-timeout`'s hint names
the nonce case explicitly, and why `csp-cdn-script-src`'s hint says that adding
an origin does nothing under `'strict-dynamic'`.

### Two findings to treat as constraints, not opportunities

- A `blob:` Worker's top-level script **runs even though it carries no nonce**,
  while the inherited policy still blocks `eval`, `new Function` and Wasm. So
  containment holds. Its `await import()` requires `'strict-dynamic'`; the
  shipped payloads have no runtime import at all.
- **WebKit 26 does not apply `'strict-dynamic'` to module scripts** (see the
  gap below). That is an engine defect in this project's favour, and no code
  path may depend on it.

## Profile B — same-origin shim Worker (NOT the default)

Use this **only** if your host cannot allow `blob:` at all. It is documented,
not implemented: the library ships no automatic fallback, and nothing selects
Profile B silently. A host opts in explicitly by passing its own
`createWorker` to `createPolicySession` / `createRuntimeController`, and by
hosting a same-origin shim worker file itself.

### What Profile B costs you

> **A same-origin network Worker does not inherit the document's CSP.** Its
> policy comes from its own HTTP response headers. Under a host document policy
> of `script-src 'self' <cdn>; connect-src 'none'` — that is, with `connect-src`
> set to `'none'` — a same-origin network Worker was observed to have:
>
> - **`eval` working** (`eval("1+1")` returned `2`),
> - **`new Function` working**,
> - **Wasm compiling** with no `'wasm-unsafe-eval'` anywhere, and
> - **cross-origin `fetch` succeeding** (HTTP 200 to the other origin), despite
>   `connect-src 'none'` on the document.
>
> So choosing Profile B removes CSP as a containment layer around the policy
> Worker and the QuickJS Worker. It does not by itself create a route from
> guest code to host powers — the guest still runs inside QuickJS with no host
> objects — but it deletes a defence-in-depth layer that Profile A provides and
> that the rest of this project's documentation assumes exists.

The only fix is to serve a CSP response header **on the shim Worker script
itself**. If that header is omitted, the Worker runs with no policy at all.

Host document:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Mandatory, on the shim Worker script's own response:

```
Content-Security-Policy: default-src 'none'; script-src 'self' <cdn> 'wasm-unsafe-eval'; connect-src <cdn>
```

Profile B's genuine advantage is that the host document needs neither `blob:`
nor `'wasm-unsafe-eval'`. Its costs are the extra same-origin file the consumer
must host, the second header the consumer must not forget, and the containment
loss above if they do. A Worker's own response policy never blocks the Worker's
own top-level script — with `script-src 'none'` on the response the Worker
script still executed on all three engines — so the header restricts the
Worker's subsequent evaluations and fetches, not its loading.

## Tested browser matrix

These are the exact builds the project tests against. `npm run check:browser`
**asserts** the launched build's reported version and fails on a mismatch;
there is no silent fallback to a different cached build.

| Engine | Version | Playwright revision | Notes |
|---|---|---|---|
| Chromium | `140.0.7339.186` | `chromium-1193` | The build the results below come from. `playwright-core` 1.55.0 pins revision `1187` (`140.0.7339.16`), which is **not installed locally**; the checker also accepts `1187` so a runner that installed browsers through `playwright-core` can run it, and it prints which build ran. No results from `1187` are recorded here. |
| Firefox | `141.0` | `firefox-1490` | Exactly `playwright-core` 1.55.0's pin. |
| WebKit | `26.0` | `webkit-2203` | Exactly `playwright-core` 1.55.0's pin. |

Driver: `playwright-core` 1.55.0. Host: macOS 24.6.0, arm64. Headless.

A previous version of `scripts/browser-check.mjs` selected "the newest
Playwright build in the local cache", which reported Chromium `153.0.8010.12`
(from `chromium_headless_shell-1243`) and Firefox `146.0.1` (from
`firefox-1509`). Those builds are present locally but are **not** what this
matrix covers, and results from them are not part of the evidence here. Run
them deliberately with `CHROME_PATH=... EXPECT_PINNED_VERSIONS=0` if you want
to extend coverage, and update this table with what you measured.

### Feature support, per pinned engine

| Property | Chromium 140.0.7339.186 | Firefox 141.0 | WebKit 26.0 |
|---|---|---|---|
| Profile A end to end (cross-origin bundle, both `blob:` Workers, opaque frame, Wasm, acknowledged render, interaction) | pass | pass | pass |
| Opaque-origin `srcdoc` frame inherits the host policy | yes | yes | yes |
| `blob:` Worker inherits the host policy | yes | yes | yes |
| Same-origin network Worker inherits the host policy | **no** | **no** | **no** |
| Cross-origin `Worker` URL usable | no, under any CSP | no, under any CSP | no, under any CSP |
| `frame-src` enforced for the `srcdoc` frame | no | no | no |
| `'wasm-unsafe-eval'` required for `WebAssembly.instantiate` (the form QuickJS uses) in the `blob:` Worker | yes | yes | **yes** |
| `'wasm-unsafe-eval'` required for `new WebAssembly.Module()` / `WebAssembly.compile()` in the `blob:` Worker | yes | yes | **no — not gated** |
| `'wasm-unsafe-eval'` required for Wasm in the host document realm | yes | only for `instantiate` | only for `instantiate` |
| `'wasm-unsafe-eval'` leaves `eval` / `new Function` blocked | yes | yes | yes |
| `require-trusted-types-for` / `trusted-types` implemented | yes | **no** | yes |
| `securitypolicyviolation` reported to the host for the frame's refused script | **no** | **no** | **no** |
| `securitypolicyviolation` reported to the host for a refused `blob:` Worker | yes (`worker-src` / `blob`) | yes (`worker-src` / `blob`) | yes (`worker-src` / `blob`) |
| `securitypolicyviolation` reported for a refused cross-origin import | yes (`script-src-elem`) | yes (`script-src-elem`) | yes (`script-src-elem`) |
| `'strict-dynamic'` ignores `'self'` and host-sources in `script-src` (classic scripts) | yes | yes | yes |
| ... and for **module** scripts | yes | yes | **no** |
| Parser-inserted no-nonce `<script type="module">` refused under `'strict-dynamic'` | yes | yes | **no** |
| `'sha256-…'` still effective alongside `'strict-dynamic'` (frame inheritance) | yes | yes | yes |
| `blob:` Worker top-level script runs under an inherited nonce policy with no nonce available | yes | yes | yes |
| `blob:` Worker `await import()` allowed by `'strict-dynamic'`, refused by a nonce alone | yes | yes | yes |
| `'strict-dynamic'` changes whether `worker-src` must list `blob:` | no | no | no |
| Nonce readable at runtime via `script[nonce].nonce` (attribute hidden) | yes | yes | yes |
| The Lean/Wasm checker instantiates from the embedded binary inside the `blob:` policy Worker | yes | yes | yes |
| Largest sibling count the checker survives (see [the path bound](#the-path-bound-is-an-engine-measurement)) | no failure observed | 5,800 ok / 6,000 overflow | 2,000 ok / 2,500 overflow |

### Known gaps in specific engines

**Trusted Types is absent on Firefox.** Firefox 141 does not implement
`require-trusted-types-for` or `trusted-types`; it logs
`Couldn't process unknown directive 'require-trusted-types-for'` and
`window.trustedTypes` is `undefined` inside the frame. The frame reports which
it got in its `ready` message, and `npm run check:browser` asserts
`trustedTypes === false` on Firefox and `true` on Chromium and WebKit. On
Firefox the only equivalent layer is the JavaScript sink hardening in
`src/frame.js` (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`setHTMLUnsafe`, `document.write`, `createContextualFragment`, `DOMParser` all
made to throw). **Do not state that Trusted Types protects the frame "in
browsers"** — it protects it on two of the three engines tested.

**WebKit does not gate every Wasm entry point.** WebKit 26 refuses
`WebAssembly.instantiate` without `'wasm-unsafe-eval'` but allows
`new WebAssembly.Module()` and `WebAssembly.compile()`. So
`'wasm-unsafe-eval'` is genuinely required on all three engines for the
production path, but **no claim of the form "the policy prevents Wasm
compilation" holds on WebKit**: code in a realm governed by that policy can
still compile a module through the synchronous constructor.

This is narrower than the spike's N5, which recorded that WebKit 26 does not
enforce CSP on Wasm compilation at all. That statement was based on probes of
`new WebAssembly.Module`, `WebAssembly.compile` and `compileStreaming`; the
`instantiate` form was not separated out. `npm run check:browser` now measures
all three forms in both realms on every engine, so the table above is the
current measurement and N5 is the earlier, broader one.

**Firefox does not gate the document realm the same way as a Worker realm.**
Without `'wasm-unsafe-eval'`, Firefox 141 allowed `new WebAssembly.Module()`
and `WebAssembly.compile()` in the host document but refused both inside the
`blob:` Worker. Since the library compiles in the Worker, Profile A needs the
token there either way.

**WebKit does not apply `'strict-dynamic'` to module scripts.** Under
`script-src 'nonce-X' 'strict-dynamic'` with no other source expression, a
parser-inserted `<script type="module" src>` with **no nonce** executed on
WebKit 26 — same-origin and cross-origin — while the equivalent classic script
was correctly refused, and both were refused once `'strict-dynamic'` was
removed. Consequence: **no claim of the form "`'strict-dynamic'` blocks
injected script tags" holds on WebKit**, and this library must not rely on the
permissive behaviour. Measured in
[spike/nonce/](../spike/nonce/nonce-strict-dynamic-feasibility.md).

### The path bound is an engine measurement

The Lean checker recurses once per **sibling** — its traversal runs in a state
monad, and `nodesToRaw`, `treeStats` and `nodesPolicyOk` each recurse over
sibling lists inside `mutual` blocks, which Lean does not turn into loops. That
recursion compiles to WebAssembly function calls, and their depth is bounded by
**the engine's own call stack**, which no build flag configures:
`-sSTACK_SIZE` controls the linear-memory stack, and the audit measured 104
bytes of that for every case.

What the recursion has open when it reaches a node is not the document's node
count but that node's ancestors, itself, and every earlier sibling of each of
them — for a flat list, the node's position. The frontend bounds exactly that
quantity as `PREPROCESS_LIMITS.maxRawPathNodes`, and bounds the node count
separately as capacity (`maxRawNodes`, equal to the policy's own `maxNodes`).
The distinction was measured with the real checker at a reduced V8 stack
(`node --stack-size=250`): a flat list trapped between 1,700 and 1,800
siblings; a 1,921-node tree trapped when every level descended through its
**last** child (1,890 open) and was accepted when every level descended through
its **first** child (71 open); wide, shallow trees of 4,368 and 4,680 nodes were
accepted; and a 100×8 table (2,733 raw nodes, 218 open at most) and a 300-item
list (2,102 raw nodes, 604 open) both passed. Under an earlier 1,000-**node**
cap the table and the list were refused.

Measured per engine by sending flat documents of increasing width through the
real policy Worker (for a flat list, open nodes equals siblings):

| Engine | Fine | Overflowed |
|---|---|---|
| Node 22 / V8 (the differential harness) | 9,000 siblings | 9,500 |
| Firefox 141 | 5,800 | 6,000 |
| WebKit 26 | 2,000, over ten consecutive calls | 2,500, on the **second** identical call |
| Chromium 140 | no failure at any width the frontend permits | — |

WebKit's threshold moved with JIT tier-up — the same 3,000-sibling document
succeeded once and trapped on the next call — so it is not a number to sit
close to. `maxRawPathNodes` is therefore **1,000**, which is 2.5x below
WebKit's observed failure and was clean over ten consecutive calls on all three
engines. Nesting costs a few frames per level on top (a 30-level chain trapped
at 1,710 open where a flat list trapped between 1,700 and 1,800), so
`npm run check:browser` also drives the deepest, widest shape the frontend
permits — `maxRawDepth` levels with earlier siblings open at every one — three
times on each engine and requires a structured policy answer every time. It
re-measures the flat bound too: a document at the bound must get a structured
answer and leave the Worker alive, one node past it must be refused by
preprocessing, and a 100×8 table above the old node cap must be accepted.

A document that overflows anyway is a bounded failure and never a render: the
trap poisons the checker instance, the request is refused, and the host
replaces the Worker. Raising the bound needs the per-sibling recursion in the
checker to become iterative, which is proved code and later work.

## Startup errors

Three of the failures above produce **no** CSP violation report, so a single
aggregate "startup failed" timeout would be useless. Startup is therefore split
into four stages, each with its own budget and its own code
(`src/startup.js`). Codes and budgets are exported from the CDN entry point as
`STARTUP_ERRORS`, `STARTUP_STAGES` and `STARTUP_TIMEOUTS`.

| Stage | Default budget | Codes |
|---|---|---|
| `worker-create` | 2 s | `csp-worker-blob`, `worker-blob-unsupported`, `worker-create-timeout`, `csp-cdn-script-src` |
| `channel-handshake` | 5 s | `channel-handshake-timeout`, `worker-startup-error` |
| `wasm-init` | 15 s | `csp-wasm-unsafe-eval`, `csp-connect-src`, `wasm-init-timeout`, `checker-init-failed` |
| `frame-bootstrap` | 5 s | `frame-bootstrap-timeout` |

`wasm-init` now covers **two** Workers, for the same reason and with the same
codes: QuickJS compiling its own binary, and the policy Worker instantiating
the embedded Lean/Wasm checker. The policy session exposes them separately —
`whenReady()` settles when the channel works, `whenCheckerReady()` when the
acceptance authority exists — because the channel completing says nothing about
whether anything can be accepted. `start()` waits for both.

If the checker does not start, the session refuses every document. There is no
fallback to the JavaScript checker: that would bypass the acceptance authority,
so the library refuses to render instead. `checker-init-failed` carries the
checker's own bounded reason, and the host classifies it — a `CompileError` in
that reason is reported as `csp-wasm-unsafe-eval`, because a `blob:` Worker
inherits the document policy and that is a header to change rather than a build
to investigate.

| Misconfiguration | Host-visible signal | Code |
|---|---|---|
| `script-src` omits the CDN origin | the dynamic `import` rejects; `securitypolicyviolation` with `effectiveDirective: script-src-elem` | `csp-cdn-script-src` |
| `worker-src`/`child-src`/`script-src` omits `blob:` | `securitypolicyviolation` `worker-src` / `blockedURI: blob`, plus a Worker `error` event. Observed: all three engines deliver the violation to the host, and all three surface it to the library as an **asynchronous** error event — including Chromium 140, which does **not** throw synchronously for this case (measured in [spike/nonce/](../spike/nonce/nonce-strict-dynamic-feasibility.md) under both a nonce policy and Profile A). So the code a consumer actually gets is `worker-startup-error`, with a hint naming `blob:`. `csp-worker-blob` comes from a synchronous throw, which is what a cross-origin Worker URL does | `worker-startup-error` (`csp-worker-blob` for a synchronous throw) |
| `script-src` omits `'wasm-unsafe-eval'` | `CompileError` inside the Worker, relayed to the host over its port. This now stops **both** Workers: QuickJS cannot compile its binary and the policy Worker cannot instantiate the Lean checker, so nothing can be accepted at all | `csp-wasm-unsafe-eval` |
| `connect-src` forbids a fetched checker asset | `fetch` / `compileStreaming` rejection inside the Worker. Not reachable in a shipped build: both binaries are embedded, and the browser check asserts no `.wasm` request is made | `csp-connect-src` |
| The Lean checker will not start for any other reason | every document is refused with a bounded reason; `whenCheckerReady()` rejects | `checker-init-failed` |
| `script-src` omits the frame script hash | **none.** No `securitypolicyviolation` on any engine. Only a bootstrap timeout. **Under a nonce host this is the default failure**, because `'unsafe-inline'` is ignored once a nonce or hash is present, so a recommended modern policy has no frame hash in it | `frame-bootstrap-timeout`, whose message lists both required hashes, names the nonce case, and explicitly does not claim a cause |
| `style-src` omits the frame style hash | the frame works, unstyled. The frame detects its own missing stylesheet and reports it | warning `frame-style-hash-missing`; startup still succeeds |
| A cross-origin Worker URL is used | Chromium throws `SecurityError`; Firefox/WebKit fire an opaque `error` event | build-time defect. Asserted against in `scripts/check-cdn.mjs` |
| The bundle and the checker module come from different builds | the checker refuses to start; the identity or the bounds it reports do not match this build's | `checker-init-failed`, detail naming the mismatch |
| A static cross-origin `import` in a Worker entry | opaque `error` event, no violation report | build-time defect. Asserted against in `scripts/build.mjs` and `scripts/check-cdn.mjs` |

A guest program that does not compile is **not** a startup failure and keeps
its own error: `wasm-init` covers the same round trip as the program compile,
so misreading one as the other would send a host to change a header it does
not need to change. `test/startup.test.js` pins that distinction.

## Reproducing this

```sh
npm run build
PORT=8096 npm run serve       # host on :8096, "cdn" origin on :8097
DEMO_URL=http://localhost:8096/ npm run check:browser
```

`check:browser` runs Chromium, Firefox and WebKit by default; restrict with
`ENGINES=webkit`. It exercises:

- the demo and the attack showcase under Profile A;
- `demo/cdn.html`, which dynamically imports the shipped bundle from the second
  origin and lets that cross-origin module create both `blob:` Workers, the
  opaque frame, compile Wasm and commit renders;
- the startup codes, by removing exactly one required token from the host
  policy: `?cspOmit=frameScriptHash|frameStyleHash|workerBlob|wasmEval|cdnScript`.
  That query parameter only ever *removes* a token, and it is a demo-server
  affordance, not a library feature;
- the Lean/Wasm acceptance authority: that it instantiates from the embedded
  binary inside the `blob:` Worker, reports this build's identity, and that a
  fabricated acceptance record, a bare accepted tree and a replayed record all
  fail to commit;
- the open-node path bound, per engine, as described above.

Profile C's evidence is the nonce spike, which has its own harness:

```sh
node spike/nonce/serve.mjs                               # host :8098, cdn :8099
ENGINES=chromium PAGES=n1 node spike/nonce/run.mjs       # one engine, one page group
ENGINES=chromium,firefox,webkit node spike/nonce/run.mjs
ONLY=nonce-sd-candidate PAGES=n2 node spike/nonce/run.mjs
node spike/nonce/summarize.mjs                           # cross-engine matrix
```

## Not tested — do not assume these work

- **`'strict-dynamic'` and nonce-based host policies** were the largest gap and
  are now measured: see [Profile C](#profile-c--nonce--strict-dynamic-hosts)
  and [spike/nonce/](../spike/nonce/nonce-strict-dynamic-feasibility.md).
  Summary: Profile A's `script-src` **host-source tokens are inert** for such
  hosts, while the two hashes, `'wasm-unsafe-eval'` and `worker-src … blob:`
  are not; Profile C is the tested policy and the nonce must be on the tag that
  loads the library. Still untested there: `report-only` mode, a `<meta>`
  -delivered nonce policy, multiple host policies, nonce reuse or rotation,
  Profile B under a nonce policy, and `script-src-elem`/`script-src-attr` as
  separate directives.
- **Real Chrome, real Safari, and mobile engines.** Chromium 140, Firefox 141
  and WebKit 26 via Playwright are proxies for them, not the products.
- **Newer engines.** Chromium 153 and Firefox 146 builds are present in the
  local Playwright cache but are not part of this matrix.
- CSP `report-only` mode, a `<meta>`-delivered host policy, COOP/COEP,
  `SharedArrayBuffer`, and service workers.
- Any CSP behaviour for a Lean/Wasm checker shipped as a separate `.wasm`
  file. That configuration needs `connect-src` as well and has not been built:
  the checker binary is embedded in the Worker payload precisely so that
  `connect-src 'none'` stays sufficient.
