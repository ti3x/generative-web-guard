# Spike: nonce-based and `'strict-dynamic'` host policies

Status: second browser feasibility spike. The first spike
([spike/policy-worker-feasibility.md](../policy-worker-feasibility.md)) recorded
nonce/`'strict-dynamic'` policies as **not tested** and called it "the
highest-value remaining gap"; `docs/csp.md` repeats that there is **no
evidence** Profile A works under such a policy. This spike closes that gap.

Everything in `spike/nonce/` is a throwaway harness. It is not wired into
`npm test`, `package.json` or CI, it imports `src/startup.js` read-only (to
classify observed errors with the shipped classifier) and it modifies no
production file and no file under `spike/` outside this directory.

Statements labelled **observed** were produced by running this harness.
Statements labelled **inferred** are explanations the observations are
consistent with, not additional measurements.

The first spike's established results are taken as given and were not
re-derived: cross-origin `new Worker()` is impossible on every engine; `blob:`
Workers inherit the document CSP while same-origin network Workers do not;
`WebAssembly.instantiate` is refused without `'wasm-unsafe-eval'`; a missing
frame script hash produces no `securitypolicyviolation`.

## Engines, versions, and how they were pinned

| Engine | Version asserted | Playwright revision | Executable |
|---|---|---|---|
| Chromium | `140.0.7339.186` | `chromium-1193` | `~/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium` |
| Firefox | `141.0` | `firefox-1490` | `~/Library/Caches/ms-playwright/firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox` |
| WebKit | `26.0` | `webkit-2203` | `~/Library/Caches/ms-playwright/webkit-2203/pw_run.sh` |

`spike/nonce/run.mjs` resolves each engine from its **pinned revision only**
and then asserts `browser.version()` against the expected string, throwing and
refusing to record results on a mismatch. There is no fallback to "newest
cached build": revisions `chromium-1243` (153.x), `chromium-1208`,
`firefox-1509` (146.x) and `webkit-2248` are all present in the local cache and
were never launched. Driver: `playwright-core` 1.55.0. Host: macOS 24.6.0,
arm64, headless.

## Reproduction

```sh
node spike/nonce/serve.mjs                              # host :8098, cdn :8099
ENGINES=chromium PAGES=n1 node spike/nonce/run.mjs      # one engine, one page group
ENGINES=chromium,firefox,webkit node spike/nonce/run.mjs
ONLY=nonce-sd-candidate PAGES=n2 node spike/nonce/run.mjs   # one CSP variant
node spike/nonce/summarize.mjs                          # cross-engine matrix + startup-code mapping
```

Harness pieces: `serve.mjs` (two origins; host CSP from `?csp64=`, per-load
nonce from `?nonce=`, worker-response CSP from `?wcsp64=`), `csp-variants.mjs`
(every policy quoted in this report, verbatim), `collector.js` (violation
recorder that survives the thing under test), `n1`–`n4` pages, the no-nonce
discriminator scripts, `cdn-guard-n.js` (cross-origin "library" for the
end-to-end run), `frame-inline.js`/`frame-inline.css`/`policy-worker.js`
(copied unchanged from `spike/`), `run.mjs`, `summarize.mjs`. Raw per-engine
JSON is in `spike/nonce/results/`, and `results/summary.txt` is the generated
cross-engine dump this report is written from.

The nonce is supplied by the driver rather than minted per response, so that
one page load and all of its subresource requests agree on a value. What is
measured is whether the header and the attribute match and what the resulting
policy permits; the provenance of the value is irrelevant to that.

---

## Verdict

**Nonce + `'strict-dynamic'` hosts are supported, but only with a markup
change the project does not currently document, and Profile A's `script-src`
host-source tokens are inert for them.**

A verified working host policy, measured end to end (cross-origin module →
`blob:` policy Worker → opaque frame → private port → Wasm → acknowledged
render) on Chromium 140, Firefox 141 and WebKit 26:

```
Content-Security-Policy: default-src 'none'; script-src 'nonce-<per-response>' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src <cdn>; object-src 'none'; base-uri 'none'; form-action 'none'
```

and the markup that loads the library **must carry that nonce**:

```html
<script type="module" nonce="<per-response>"
        src="https://<cdn>/generative-web-guard.full.min.js"></script>
```

Per-token justification, each observed in this spike:

| Token | Why |
|---|---|
| `script-src 'nonce-<per-response>'` | The only thing that makes the library's `<script>` tag load. Under `'strict-dynamic'` neither `'self'` nor the CDN host-source can do it. Observed: with `script-src 'self' <cdn> 'nonce-X' 'strict-dynamic'` and the nonce removed from the tag, the library's own module **did not run** on Chromium and Firefox. |
| `script-src 'strict-dynamic'` | Not required by the library; it is what the *host* already has. Keeping it costs nothing: everything the library does still works. It is what permits the library's programmatically inserted scripts, if it ever adds any. |
| `script-src 'wasm-unsafe-eval'` | Still required and still effective next to `'strict-dynamic'`. Observed: removing it refused `WebAssembly.instantiate` inside the `blob:` Worker on all three engines. |
| `script-src 'sha256-<frameScript>'` | **Hashes survive `'strict-dynamic'`.** Observed on all three engines: with the hash present the `srcdoc` frame bootstrapped and committed renders; with it removed the frame was dead and nothing reported why. |
| `style-src 'self' 'sha256-<frameStyle>'` | Same inheritance. Observed: removing it left the frame working but unstyled (frame `#root` computed `font-size` 16px instead of 13px) on all three engines. |
| `worker-src 'self' blob:` | Still required. `'strict-dynamic'` in `script-src` does **not** change Worker creation. Observed: with `worker-src 'self'`, both `blob:` Workers were refused on all three engines. |
| `connect-src <cdn>` | Only if an asset is fetched at runtime; unchanged from Profile A. |
| `default-src 'none'`, `object-src`, `base-uri`, `form-action` | Unchanged hardening. |

**The `<cdn>` token in `script-src` must be dropped from the documented policy
for these hosts, or documented as inert.** Observed on Chromium and Firefox:
with `script-src 'self' <cdn> 'nonce-X' 'strict-dynamic'`, a parser-inserted
cross-origin `<script src="<cdn>/...">` **without** a nonce was refused
(`securitypolicyviolation`, `effectiveDirective: script-src-elem`), while the
identical tag ran when `'strict-dynamic'` was removed. Firefox says so out
loud in the console:

```
Content-Security-Policy: Ignoring "'self'" within script-src: 'strict-dynamic' specified
Content-Security-Policy: Ignoring "http://127.0.0.1:8099" within script-src: 'strict-dynamic' specified
```

This matches CSP3 §`strict-dynamic`, which specifies that host-source and
scheme-source expressions, `'self'` and `'unsafe-inline'` are ignored while
nonces and hashes remain effective
(https://www.w3.org/TR/CSP3/#strict-dynamic-usage). Telling a nonce host to
"add the CDN origin to `script-src`" is advice that does nothing.

### The blunt negative result

**A consumer on the policy that Google's CSP Evaluator recommends, and that
Rails/Django/Next-style generators emit, gets a library that half-starts and
then hangs.** Exact policy tested (`http:` added because the harness is
plaintext; otherwise verbatim the recommended form):

```
script-src 'nonce-<per-response>' 'strict-dynamic' https: http: 'unsafe-inline'; object-src 'none'; base-uri 'none'
```

Observed on all three engines, with the library loaded from a nonce'd tag:
the cross-origin module imported fine, the `blob:` policy Worker was created
and its port was installed, and then

- the `srcdoc` frame **never started** (no frame script hash in the policy;
  `'unsafe-inline'` is ignored because a nonce is present), and
- Wasm was refused for want of `'wasm-unsafe-eval'`: `WebAssembly.instantiate`
  on all three engines, and the end-to-end probe's `new WebAssembly.Module` on
  Chromium and Firefox (WebKit permitted that one form, the split `docs/csp.md`
  already records).

The host-visible signal is a render that never settles — 8 s to the spike's
`render ack` timeout, and in the real library the `frame-bootstrap` stage
timeout. There is **no `securitypolicyviolation` event anywhere in the host
document** for the frame failure on any of the three engines. The only trace is
a console message logged against `about:srcdoc`, which no host code can read:

```
Refused to execute inline script because it violates the following Content Security
Policy directive: "script-src 'nonce-Rcy1WCKUu7iLiQFcACuuMQ' 'strict-dynamic' https: http:
'unsafe-inline'". Note that 'unsafe-inline' is ignored if either a hash or nonce value is
present in the source list.
```

So the first spike's N8 is not merely preserved under nonce policies, it
becomes the *default* experience of a modern-CSP consumer. That is the finding
that matters most for `src/startup.js`.

---

## Answers to the seven questions

### Q1. Does the CDN module load at all under `script-src 'nonce-X' 'strict-dynamic'`? (page `n1`)

Observed. `Y` = the script executed, `-` = refused.

| Load path (all parser-inserted unless noted) | `nonce-sd-bare`¹ Chromium | Firefox | WebKit | `nonce-only-bare`² all three |
|---|---|---|---|---|
| `<script nonce src="<cdn>/x.js">` (classic, cross-origin, nonce'd) | Y | Y | Y | Y |
| `<script type="module" nonce src="<cdn>/x.js">` (cross-origin, nonce'd) | Y | Y | Y | Y |
| `<script src="<cdn>/x.js">` no nonce | - | - | - | - |
| `<script src="/x.js">` no nonce (same-origin, classic) | - | - | - | - |
| `<script type="module" src="/x.js">` no nonce (same-origin) | - | - | **Y** | - |
| `<script type="module" src="<cdn>/x.js">` no nonce (cross-origin) | - | - | **Y** | - |
| host module → `createElement("script")` + `appendChild`, no nonce | Y | Y | Y | - (error) |

¹ `default-src 'none'; script-src 'nonce-{NONCE}' 'strict-dynamic'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`
² the same with `'strict-dynamic'` removed.

Answers:

- **Yes, the module loads — from a nonce'd `<script type="module">` tag**, on
  all three engines, under every nonce variant tested including the bare
  `script-src 'nonce-X' 'strict-dynamic'` with no allowlist at all. This is
  the supported path.
- **The `<cdn>` token really is ignored.** Decisive pair: with
  `script-src 'self' <cdn> 'nonce-X' 'strict-dynamic'` the non-nonce'd
  cross-origin tag was refused; with `'strict-dynamic'` removed
  (`script-src 'self' <cdn> 'nonce-X'`) the same tag ran. Chromium and Firefox
  both reported `securitypolicyviolation` with
  `effectiveDirective: script-src-elem` and `blockedURI` set to the script URL.
- **`'self'` is ignored too, which breaks the currently documented markup.**
  `demo/cdn.html` ships `<script type="module" src="/dist/cdn.js">` with no
  nonce. Under `script-src 'self' <cdn> 'nonce-X' 'strict-dynamic'` that tag
  was refused on Chromium and Firefox and the library never ran. Self-hosting
  the bundle same-origin does **not** fix this; only a nonce on the tag does.
- **WebKit 26 does not apply `'strict-dynamic'` to parser-inserted module
  scripts.** Observed under `script-src 'nonce-X' 'strict-dynamic'` with no
  `'self'`, no scheme-source and no host-source: a parser-inserted
  `<script type="module" src>` with **no nonce** executed, both same-origin and
  cross-origin, while the parser-inserted *classic* script with no nonce was
  correctly refused; and with `'strict-dynamic'` removed the same module tags
  were correctly refused. So it is `'strict-dynamic'` that unlocks them.
  Inferred: WebKit is not setting/consulting "parser-inserted" parser metadata
  for module scripts, so CSP3's non-parser-inserted allowance
  (https://www.w3.org/TR/CSP3/#strict-dynamic-usage) fires for them. This is a
  **WebKit CSP weakening, not a feature**: on WebKit 26 a `'strict-dynamic'`
  policy does not protect against an HTML injection that writes
  `<script type="module" src="https://evil/x.js">`. We must not depend on it,
  and the support matrix must not record "works on WebKit" for the no-nonce
  tag on that basis.

### Q2. Does trust propagate to `await import()` of a cross-origin payload? (page `n1`)

Observed, all three engines: **yes — and the mechanism is nonce inheritance,
not `'strict-dynamic'`.** From a nonce'd host module,
`await import("<cdn>/payload.js")` succeeded under every variant, including
`nonce-only-bare` = `script-src 'nonce-X'` with **no** `'strict-dynamic'`, no
`'self'` and no CDN host-source. A cross-origin module loaded from a nonce'd
tag could likewise chain a further `await import()` of a second cross-origin
module.

Inferred: HTML propagates the importing script's fetch options, including its
cryptographic nonce, to dynamic imports, so the import matches
`'nonce-X'` directly; CSP3's `'strict-dynamic'` non-parser-inserted allowance
would also cover it, but the `nonce-only-bare` row shows it is not needed in
the document realm. The distinction matters because it is **reversed inside a
Worker** — see Q3.

Programmatic insertion is the case that does discriminate: a script element
created with `createElement` + `appendChild` and no nonce loaded under every
`'strict-dynamic'` variant and was refused (`onerror`) under `nonce-only-bare`,
exactly as CSP3 specifies.

### Q3. What does a `blob:` Worker inherit from a nonce policy? (page `n2`) — the crux

Observed, all three engines, under
`script-src 'nonce-X' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-…'; worker-src 'self' blob:`:

| Inside the `blob:` Worker | Chromium 140 | Firefox 141 | WebKit 26 |
|---|---|---|---|
| Worker constructed | ok | ok | ok |
| **Its own top-level script ran** | **yes** | **yes** | **yes** |
| `await import("<cdn>/payload.js")` | ok | ok | ok |
| `new WebAssembly.Module` / `WebAssembly.instantiate` | ok / ok | ok / ok | ok / ok |
| `eval("1+1")` | `EvalError` (refused) | `EvalError` (refused) | `EvalError` (refused) |
| `new Function` | refused | refused | refused |
| cross-origin `fetch` (with `connect-src <cdn>`) | status 200 | status 200 | status 200 |
| nested `blob:` Worker | ok | ok | ok |

So of the two plausible outcomes, the first is what happens: **the blob's
top-level script runs even though it carries no nonce**, while the inherited
policy is otherwise fully in force — the same Worker's `eval`, `new Function`
and (without the token) Wasm are all refused by the inherited nonce policy.
Inferred: a Worker's own top-level script is not matched against `script-src`
at all (the first spike observed the same thing from the other direction: a
Worker response carrying `script-src 'none'` still ran its own script), so the
absence of a nonce is simply never consulted.

The Worker's `await import()` is the one place where `'strict-dynamic'` is
load-bearing rather than incidental. Decisive pair, both with
`worker-src 'self' blob:`:

```
script-src 'nonce-X' 'strict-dynamic' 'wasm-unsafe-eval'   -> worker await import() OK
script-src 'nonce-X'                  'wasm-unsafe-eval'   -> worker await import() BLOCKED
```

Blocked messages: Chromium `TypeError: Failed to fetch dynamically imported
module: …`, Firefox `TypeError: error loading dynamically imported module: …`,
WebKit `TypeError: Importing a module script failed.` So the importing script's
nonce is **not** inherited into a `blob:` Worker's dynamic import the way it is
in the document. This does not affect the shipped build — `src/cdn-full.js`
embeds both payloads as source and `scripts/check-cdn.mjs` asserts there is no
runtime import — but it is a trap for any future payload that adds one, and it
inverts the Q2 answer.

### Q4. Is `worker-src blob:` still required? (page `n2`)

Observed. `'strict-dynamic'` in `script-src` does not change Worker creation at
all. Identical on all three engines:

| Applicable worker source, with `'strict-dynamic'` in `script-src` | `blob:` Worker |
|---|---|
| `worker-src 'self' blob:` | created, ran |
| `worker-src 'self'` (no `blob:`) | **refused** |
| `worker-src 'nonce-X' 'strict-dynamic' blob:` | created, ran |
| no `worker-src`; `child-src 'self' blob:` | created, ran |
| no `worker-src`/`child-src`; `blob:` in `script-src`, `default-src 'none'` | created, ran |
| no `worker-src`/`child-src`; `default-src blob:` | created, ran |
| no `worker-src`/`child-src`/`default-src` at all (the recommended real-world policy) | created, ran |

Two things follow. First, the fallback chain reaches `script-src`: with
`default-src 'none'` present and `blob:` listed only in `script-src`, the
Worker was still created, so `script-src` was consulted before `default-src`
on all three engines. Second, and this is the part that could have gone the
other way, **`'strict-dynamic'` did not void the `blob:` scheme-source for the
Worker request** — not when it sat beside `blob:` in `script-src`, and not even
when it was placed directly in `worker-src`. Inferred: engines apply the
`'strict-dynamic'` source-list rewriting only to script-element/script-import
checks, not to the Worker request check.

A nonce-style policy therefore needs exactly what Profile A needs:
`blob:` in whichever of `worker-src` → `child-src` → `script-src` →
`default-src` applies. A policy with none of those four present gets `blob:`
Workers for free, which is why the CSP-Evaluator-recommended policy passes
this question while failing Q5 and Q6.

### Q5. Do the frame's pinned hashes survive? (page `n3`)

Observed. `srcdoc` frame state was read by the driver from inside the frame,
not self-reported by the page.

| Host policy | frame script ran | render committed | frame `#root` font | Chromium/Firefox/WebKit |
|---|---|---|---|---|
| `nonce-sd-candidate` (nonce + `'strict-dynamic'` + both hashes) | yes | yes | 13px (styled) | identical on all three |
| same, frame script hash removed | **no** | no | — | identical on all three |
| same, frame style hash removed | yes | yes | 16px (unstyled) | identical on all three |
| `nonce-only-with-hashes` (no `'strict-dynamic'`) | yes | yes | 13px | identical on all three |
| CSP-Evaluator recommended (`'unsafe-inline'`, no hashes) | **no** | no | — | identical on all three |

**Hashes survive `'strict-dynamic'` on all three engines**, as CSP3 §`script-src`
and §`strict-dynamic` require, and the frame's opaque origin (`location.origin`
= `"null"`) and single-port render route are unaffected: the acknowledged
render committed and the host's own direct `postMessage` render attempt was
refused by the frame (`parentRenderAttemptsAfterBootstrap: 1`, DOM unchanged).
Nothing here needs the frame policy loosened.

The failure rows are the first spike's N8 repeated verbatim under nonce
policies: **zero `securitypolicyviolation` events in the host document on any
engine**, the frame simply never posts `frame-alive`, and the only artefact is
a console line attributed to `about:srcdoc`.

Contingency, measured because "hashes are dead under `'strict-dynamic'`" was a
plausible outcome: if the page nonce is injected into the frame document's
inline `<script nonce=…>` (harness `?frameNonce=1`), the frame comes up on all
three engines **even with no hash in the host policy**, including under the
CSP-Evaluator recommended policy — so nonces are inherited into a sandboxed
opaque-origin `srcdoc` document and still match. A module can also recover the
nonce at runtime: `document.currentScript` is `null` in a module, but
`document.querySelector("script[nonce]").nonce` returned the live value on all
three engines while `getAttribute("nonce")` returned `""` (nonce hiding).

**This contingency is reported as available and recommended against.** It is
not needed (hashes work), and it would copy the host's nonce into an
`iframe.srcdoc` attribute that any same-document script can read, defeating the
nonce-hiding the engines implement precisely to stop a page-level XSS from
harvesting nonces. The cost is a real reduction in the host's own XSS
protection in exchange for nothing.

### Q6. Does `'wasm-unsafe-eval'` remain effective alongside `'strict-dynamic'`? (page `n2`)

Observed: **yes, unchanged.** With the token, `new WebAssembly.Module`,
`WebAssembly.compile` and `WebAssembly.instantiate` all succeeded inside the
`blob:` Worker on all three engines. With the token removed from an otherwise
identical nonce + `'strict-dynamic'` policy, `WebAssembly.instantiate` was
refused on all three:

- Chromium: `CompileError: WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script …`
- Firefox: `CompileError: call to WebAssembly.instantiate() blocked by CSP`
- WebKit: `CompileError: Refused to create a WebAssembly object because 'unsafe-eval' or 'wasm-unsafe-eval' is not an allowed source of script …`

`docs/csp.md`'s existing engine split is reproduced exactly under a nonce
policy: WebKit 26 refused `instantiate` but allowed `new WebAssembly.Module`
(`wasmSync: ok` with no token), Chromium and Firefox refused both. `eval` and
`new Function` stayed refused everywhere `'wasm-unsafe-eval'` was present, so
the token still does not re-enable string evaluation under `'strict-dynamic'`.

### Q7. What does the host actually observe in each broken configuration?

Observed. The last column is the code the **shipped** classifier produces:
`spike/nonce/summarize.mjs` feeds each observed error string through
`classifyStartupFailure` imported from `src/startup.js`.

| Broken configuration | Host-visible signal (all three engines unless noted) | `securitypolicyviolation`? | Code a consumer would get |
|---|---|---|---|
| Library tag has no nonce (`'self'`/`<cdn>` ignored) | the library never runs; the *page* gets a violation event and a console error, but no library code exists to see it | yes — `script-src-elem`, `blockedURI` = the bundle URL (Chromium, Firefox). WebKit: the module **ran** instead | **none. No startup code is reachable, because nothing started.** |
| `worker-src` omits `blob:` | `new Worker()` **returned normally** and then fired an opaque `error` event (message `"error"`); Worker never ran | yes, all three — `worker-src` / `blockedURI: blob` | `worker-startup-error` (classifier returns no match for `"error"` and falls back). Same observed under Profile A, so this is not nonce-specific |
| `script-src` omits `'wasm-unsafe-eval'` | `CompileError` inside the `blob:` Worker, relayable over its port | yes (`script-src` / `wasm-eval`) | `csp-wasm-unsafe-eval` — correct on all three engines |
| `script-src` omits the frame script hash (includes the CSP-Evaluator policy) | **nothing.** Frame never posts `frame-alive`; render never settles; only an `about:srcdoc` console line | **no, on any engine** | `frame-bootstrap-timeout` — an unactionable timeout unless its hint names the nonce case |
| `style-src` omits the frame style hash | frame works, unstyled (13px → 16px) | no | warning only, as today |
| Worker `await import()` with no `'strict-dynamic'` and no CDN host-source | `TypeError` inside the Worker | no | `csp-cdn-script-src` on Chromium/Firefox; **no match on WebKit** (`"Importing a module script failed."`) → falls back to `worker-startup-error` |

**Two unactionable failures, and they are the two most likely ones for a
nonce host.** The first (no nonce on the tag) cannot be reported by the library
at all and is therefore a documentation problem only. The second (no frame
hash) is the observable failure mode of the policy most nonce hosts already
have, and today's `frame-bootstrap-timeout` hint does not mention nonces,
`'strict-dynamic'`, or the fact that `'unsafe-inline'` is ignored once a nonce
is present — so a consumer reading it would not know what to change.

---

## Consumer guidance (concrete)

For a host on a nonce/`'strict-dynamic'` policy:

1. **Put the nonce on the library's script tag.** This is not optional and it
   is the whole difference between working and not working. Neither
   self-hosting the bundle nor adding the CDN origin to `script-src` is a
   substitute — both were measured and neither works.

   ```html
   <script type="module" nonce="{{ csp_nonce }}"
           src="https://cdn.example/generative-web-guard.full.min.js"></script>
   ```

   Or, keeping the documented two-step shape, nonce the host's own bootstrap
   module; its `await import()` of the cross-origin bundle then inherits the
   nonce (verified on all three engines, and verified to work even with no
   `'strict-dynamic'` at all):

   ```html
   <script type="module" nonce="{{ csp_nonce }}" src="/app.js"></script>
   ```
   ```js
   const guard = await import("https://cdn.example/generative-web-guard.full.min.js");
   ```

2. **Send this header** (`<per-response>` is the same value as the tag's
   `nonce`, fresh per response; `<frameScript>`/`<frameStyle>` are this build's
   `scriptHash`/`cssHash` from `dist/frame-manifest.json`):

   ```
   Content-Security-Policy: default-src 'none'; script-src 'nonce-<per-response>' 'strict-dynamic' 'wasm-unsafe-eval' 'sha256-<frameScript>'; style-src 'self' 'sha256-<frameStyle>'; worker-src 'self' blob:; connect-src <cdn>; object-src 'none'; base-uri 'none'; form-action 'none'
   ```

3. **If you already ship the CSP-Evaluator policy, three tokens must be
   added to it**, or the library will load and then hang:
   `'sha256-<frameScript>'` and `'sha256-<frameStyle>'` (or the frame never
   starts, silently) and `'wasm-unsafe-eval'` (or Wasm is refused). Keep
   `'strict-dynamic'`; drop nothing. `worker-src` is only needed if that policy
   also has `worker-src`, `child-src` or `default-src` — if it has none of
   them, `blob:` Workers are already permitted.

4. **Do not add the CDN origin to `script-src` and expect it to help.** With
   `'strict-dynamic'` present it is ignored; Firefox logs exactly that.

5. **Safari caveat.** On WebKit 26 a no-nonce `<script type="module">` runs
   under `'strict-dynamic'` anyway. Do not build a deployment on that: it is
   an engine defect, it is not what Chromium or Firefox do, and it weakens the
   host's own XSS protection independently of this library.

---

## Recommended edits to `docs/csp.md` (described, **not applied** — another agent owns that file)

1. **Add a "Profile C — nonce + `'strict-dynamic'` hosts" section** after
   Profile A and before "Why the Worker payload is a self-contained `blob:`".
   Content: the header block from the Verdict above, the required nonce'd
   `<script>` markup, and the per-token table above. State plainly that
   Profile C is Profile A with `'self' <cdn>` in `script-src` replaced by
   `'nonce-…' 'strict-dynamic'`, that the two hashes, `'wasm-unsafe-eval'` and
   `worker-src … blob:` are unchanged and still required, and that the nonce on
   the library's tag is mandatory.

2. **In Profile A's "Why each token is there" table**, amend the
   `script-src <cdn>` row: add "This token is **ignored** if the host policy
   also contains `'strict-dynamic'` (CSP3 §strict-dynamic; Firefox logs
   `Ignoring "…" within script-src: 'strict-dynamic' specified`). Such hosts
   must use Profile C and put the nonce on the library's script tag." Amend the
   `script-src 'self'` row the same way, and note that `demo/cdn.html`'s
   non-nonce'd `<script type="module" src="/dist/cdn.js">` is refused under
   `'strict-dynamic'` on Chromium and Firefox.

3. **Replace the first "Not tested" bullet** (`'strict-dynamic'` and
   nonce-based host policies … "there is **no evidence** that Profile A works
   under a `'strict-dynamic'` host policy") with a pointer to this spike and a
   one-line summary: Profile A's `script-src` host-sources are inert for such
   hosts, the hashes and `'wasm-unsafe-eval'` and `worker-src blob:` are not,
   and Profile C is the tested policy.

4. **Add rows to "Feature support, per pinned engine"** (Chromium 140 /
   Firefox 141 / WebKit 26):
   - `'strict-dynamic'` ignores `'self'` and host-sources in `script-src`:
     yes / yes / yes for classic scripts, **no for module scripts on WebKit**.
   - Parser-inserted no-nonce `<script type="module">` refused under
     `'strict-dynamic'`: yes / yes / **no**.
   - `'sha256-…'` still effective alongside `'strict-dynamic'` (frame
     inheritance): yes / yes / yes.
   - `blob:` Worker top-level script runs under an inherited nonce policy with
     no nonce available: yes / yes / yes.
   - `blob:` Worker `await import()` allowed by `'strict-dynamic'`, refused by
     a nonce alone: yes / yes / yes.
   - `'strict-dynamic'` changes whether `worker-src` must list `blob:`:
     no / no / no.
   - Nonce readable at runtime via `script[nonce].nonce` (attribute hidden):
     yes / yes / yes.

5. **Add to "Known gaps in specific engines"** a subsection: *"WebKit does not
   apply `'strict-dynamic'` to module scripts."* Quote the measurement: under
   `script-src 'nonce-X' 'strict-dynamic'` with no other source expression, a
   parser-inserted `<script type="module" src>` with no nonce executed on
   WebKit 26 (same-origin and cross-origin) while the equivalent classic script
   was refused, and both were refused once `'strict-dynamic'` was removed.
   State the consequence: **no claim of the form "`'strict-dynamic'` blocks
   injected script tags" holds on WebKit**, and the library must not rely on
   the permissive behaviour.

6. **In the startup-errors table**, amend the frame-hash row to name the nonce
   case: under a nonce host the missing hash is the *default* failure, because
   `'unsafe-inline'` in the host policy is ignored once a nonce or hash is
   present. Also correct the `worker-src` row's parenthetical: this spike
   observed that **Chromium 140 does not throw synchronously** for a refused
   `blob:` Worker — `new Worker()` returned normally and an opaque `error`
   event followed, on all three engines, under both a nonce policy and
   Profile A. All three engines did deliver the `securitypolicyviolation`
   (`worker-src` / `blob`) to the host, which is what the table already says.

7. **In "Reproducing this"**, add the `spike/nonce/` commands from this report
   as the evidence trail for Profile C.

## Recommended changes to `src/startup.js` (described, **not applied**)

Question 7 shows two unactionable failures, so these are worth making.

1. **`frame-bootstrap-timeout` hint — the important one.** It currently says to
   check that `script-src` contains the frame script hash and `style-src` the
   style hash. Add, without claiming a cause (there is still no violation event
   to justify one): *"If the host policy is nonce-based, note that
   `'strict-dynamic'` does **not** disable hashes — the frame hash is still
   required and still works — and that `'unsafe-inline'` is ignored whenever a
   nonce or hash is present, so a nonce policy with `'unsafe-inline'` and no
   frame hash produces exactly this timeout on every engine."* This is the
   observed failure of the most common modern CSP; the hint is the only lever
   the library has, because no event fires.

2. **Add one startup error code for the un-loadable case, for the host's
   benefit rather than the library's.** The library cannot report "your script
   tag had no nonce" (it never ran), so the code cannot be raised from inside.
   The useful form is a documented named condition the consumer can search for,
   raised by the **host-side** entry point when it is reachable at all — e.g.
   keep `csp-cdn-script-src` but widen its hint to: *"Add the library origin to
   `script-src` **unless** the policy contains `'strict-dynamic'`, in which case
   the origin token is ignored and the fix is a `nonce` attribute on the tag
   that loads the library (docs/csp.md Profile C)."* That is a one-line hint
   change with no behaviour change, and it is the string a consumer will find
   when they search for why nothing happened.

3. **`classifyStartupFailure`: add WebKit's dynamic-import message.** WebKit 26
   reports `TypeError: Importing a module script failed.`, which matches none of
   the current patterns and falls through to `worker-startup-error`. Adding
   `/Importing a module script failed/i` to the branch that already matches
   `/dynamically imported module|script-src-elem/i` makes the three engines
   agree. Low impact — shipped payloads contain no runtime import and
   `scripts/check-cdn.mjs` asserts it — but free.

4. **Correct the comment in `createBlobWorker`.** It says "Chromium throws
   synchronously when `worker-src` omits `blob:`. Firefox and WebKit instead
   fire an async error event." Observed here on Chromium 140.0.7339.186, under
   both a nonce policy and the Profile A shape: `new Worker()` returned
   normally and an opaque `error` event followed, i.e. the same as Firefox and
   WebKit. The `try`/`catch` path that raises `csp-worker-blob` at
   `worker-create` therefore appears to be unreachable for this case on all
   three engines, and `worker-startup-error` at `channel-handshake` is what a
   consumer actually gets. Keep the defensive `catch` (the cross-origin-URL
   `SecurityError` still reaches it) but fix the claim, and consider adding
   `blob:` to the `worker-startup-error` hint's first sentence — it is already
   there, which is why the current behaviour is acceptable.

No change is recommended to any policy the library emits, and nothing in this
spike required loosening the frame policy, enabling `'unsafe-eval'` or
`'unsafe-inline'`, or restoring `allow-same-origin`. The one mechanism that
would have required weakening something — injecting the host nonce into the
frame — is not needed and is recommended against on its own merits (Q5).

## Not tested (do not assume these were covered)

- **`Content-Security-Policy-Report-Only`** with any nonce policy, and the
  interaction of an enforced plus a report-only policy. Not touched.
- **A `<meta http-equiv>`-delivered host policy** containing a nonce. Only
  header-delivered host policies were tested (the frame's own policy is still
  `<meta>`, as in production).
- **Multiple host policies** (two `Content-Security-Policy` headers, or a
  header plus a `<meta>`), where every policy must independently allow a load.
  A nonce host behind a CDN or WAF that appends its own policy is a realistic
  configuration and was not measured.
- **Nonce reuse and staleness**: one fresh nonce per page load was used
  throughout. Nothing was measured about a host that reuses a nonce, rotates it
  mid-session, or renders cached HTML with a stale nonce.
- **`'strict-dynamic'` with real bundlers' output.** The harness's "library" is
  `cdn-guard-n.js` plus a copied `policy-worker.js`; the real
  `generative-web-guard.full.min.js`, real QuickJS and real Lean/Wasm modules
  were not loaded. Wasm evidence is an 8-byte empty module, as in the first
  spike: it establishes the CSP requirement, not cold-start or memory
  behaviour.
- **Profile B (same-origin shim Worker) under a nonce policy.** Only `blob:`
  Workers were tested here. A shim Worker's own response policy is unaffected
  by the document's nonce, but the combination was not measured.
- **`trusted-types` / `require-trusted-types-for` interaction with nonces**,
  and whether a `trusted-types` directive in the *host* policy changes frame
  inheritance. The frame's own policy was left exactly as `src/host.js` builds
  it and was not varied.
- **`script-src-elem` / `script-src-attr` as separate host directives**, and
  `'strict-dynamic'` placed in `script-src-elem` only. Only `script-src` (plus
  the `worker-src`/`child-src`/`default-src` chain) was varied.
- **`'unsafe-hashes'`, `'inline-speculation-rules'`, `nonce` on `<style>`**, and
  any `style-src` nonce variant. Style was only ever tested as
  `'self'` + `'sha256-…'`.
- **Real Chrome, real Safari, real Firefox, and mobile engines.** Chromium 140,
  Firefox 141 and WebKit 26 via Playwright are proxies. Newer cached builds
  (Chromium 153, Firefox 146, WebKit 2248) were deliberately not launched.
- **Teardown, message-size and performance characterisation.** The end-to-end
  round trip was 25–30 ms for a one-node tree on all three engines, which says
  nothing about anything larger.
- **Hostile markup and the real renderer.** As with the first spike, one text
  node was rendered; this says nothing about policy correctness.
