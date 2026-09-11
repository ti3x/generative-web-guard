# Generative Web Guard architecture plan

HTML and SVG validation with isolated JavaScript interactions

8 September 2026 (revised after review; reference implementation in this repository)

## 1 Purpose and scope

Allow an LLM to generate familiar HTML, SVG and JavaScript for simple interactive information visualizations, while restricting the result to local computation and display. The system supports toggles, tabs, sorting, filtering, calculators, chart selection and tooltips. All data is supplied before execution. External navigation and content-driven network requests are disabled.

The design has three layers, each of which must fail independently before generated content can do anything beyond local display:

1. **Policy layer.** A reconstruct-from-allowlist checker turns parser output into a *structured tree* containing only permitted constructs. Two implementations exist and are differentially tested against each other: a Lean 4 checker with proofs, run in Docker as the executable specification and CI oracle, and a JavaScript checker that ships in the host and the frame.
2. **Rendering layer.** A renderer builds real DOM nodes from the structured tree using namespaced constructors only. No HTML string exists after validation, anywhere.
3. **Browser-enforced layer.** Generated content renders inside a sandboxed, null-origin iframe whose Content Security Policy denies every source, pins the frame's own script and stylesheet by hash, and enforces Trusted Types with no policies. Interaction code runs in QuickJS compiled to WebAssembly inside a Web Worker with memory, stack and time limits.

The first two layers are what the proofs will be about. The third is what stops a bug in the first two from mattering.

### Threat model

The attacker is the model, under prompt injection or otherwise, producing arbitrary HTML, SVG and JavaScript. The user is trusted. Assets, in priority order:

- The host application's origin, credentials, DOM and storage.
- The network: no request may be attributable to generated content.
- The user's attention: generated content must not impersonate host UI or steal focus.
- Browser autofill data, which is a data source even for an "offline" page.
- Host resources: CPU, memory and frame rate.

Out of scope: truthfulness of displayed text and graphics, and prompt-injection content that is merely misleading. The policy strips bidi override characters as a small hedge and nothing more.

### Permitted content

| Surface | Allowed | Removed or rejected |
|---|---|---|
| HTML | Text, headings, lists, tables, containers and basic controls | Embedded documents, plugins, forms, anchors, scripts, styles, templates and inline event handlers |
| Styling | Class names extracted from the bundled stylesheet | Generated stylesheets, `style` attributes, remote fonts and CSS resource references |
| SVG | Basic shapes, paths, groups, text, `title` and `desc` | Scripts, `foreignObject`, `image`, `use`, `a`, `textPath`, filters, masks, clip paths, animation, any `href` |
| Controls | `button` (type forced to `button`), text, number, range, search, checkbox and radio inputs, select, textarea; `autocomplete` forced to `off` | Password, hidden, file, image and submit inputs, `autofocus`, `accesskey`, `contenteditable`, `tabindex` outside 0 and -1, any `name` attribute |
| JavaScript | Synchronous state updates, calculations, array operations and view generation | Browser APIs, imports, dynamic code, async, generators, timers |
| Resources | Supplied data and bundled application assets | Remote images, scripts, styles, data and external navigation |

Numeric geometry is bounded and re-emitted canonically without exponents, NaN or infinities. Path data is tokenized into commands and bounded numbers. Paint accepts only solid colors. Element ids are accepted only in identifier form and always emitted with the `g-` prefix, with id references rewritten to match, so generated ids cannot collide with host ids or clobber named properties. Attributes are carried as name/value pairs, never as object keys.

For HTML and SVG, reconstruct permitted content and report removals. For unsupported JavaScript, return diagnostics for regeneration instead of deleting statements and executing the remainder.

## 2 Execution and interaction interface

Accept ordinary HTML and optional JavaScript source as separate fields. Embedded scripts in HTML are always removed. The interaction source follows a small state and events interface:

```js
const initialState = { count: 0 };

function update(state, event) {
  if (event.action === "increment" && event.type === "click") {
    return { ...state, count: state.count + 1 };
  }
  return state;
}

function view(state) {
  return `<p>Count: ${state.count}</p>
    <button type="button" data-action="increment">+</button>`;
}
```

### Trusted execution loop

1. Parse the initial HTML with a non-executing parser (parse5 in Node, `DOMParser` in the browser) into a raw tree. The adapter records namespace, tag, attributes and children faithfully and filters nothing.
2. Run the policy. The result is a structured tree and a change list, or a rejection with reasons.
3. Check the interaction source with the AST gate. Rejections carry line and column.
4. Start a fresh QuickJS runtime in a worker. Evaluate a prelude that captures `JSON` and `String`, then bind the host-supplied dataset as a deep-frozen global named `data`, then the program, then an interface check. Data never round-trips through model output.
5. Convert permitted user interactions into plain-data events with a fixed schema.
6. Invoke `update` then `view` inside the runtime. State crosses the boundary only as JSON text embedded as a string literal, never concatenated into program text. The host owns the state.
7. Parse and validate every returned view as in steps 1 and 2.
8. Post the structured tree to the frame. The frame re-runs the policy and requires a fixed point with no changes before rendering.

Event bindings use validated `data-action` identifiers. Click, input, change and a fixed set of keys are forwarded from `data-action` elements. Pointer events are forwarded only from elements that opt in with `data-hover`, and pointer moves are coalesced to one per animation frame. Real DOM nodes, browser event objects and host functions never enter generated code. The renderer patches in place, so focus, selection and in-progress control values survive updates.

### Runtime limits and failures

The AST gate is a compatibility and policy check; isolation supplies the execution boundary. QuickJS receives no network, storage, browser, filesystem or privileged APIs [1].

| Limit | Default |
|---|---|
| Runtime memory | 32 MiB |
| Runtime stack | 512 KiB |
| Program load and interface check | 500 ms |
| One `update` plus `view` | 200 ms interrupt, 1500 ms host watchdog |
| Worker startup plus Wasm instantiation plus load | 15 s host watchdog |
| Host data | 4 MiB JSON, 2 s to bind |
| View string | 400k characters |
| Tree nodes / depth / text | 5000 / 32 / 20k per node, 200k total |
| Event queue | 32 pending, extras dropped and counted |

On any failure the host terminates the worker, stops interaction processing, keeps the last validated view in the frame, and shows a trusted indicator outside the frame. There is no fallback to browser execution. Every step is tagged with a runtime generation and a sequence number, and responses that do not match are dropped.

## 3 Structured tree, rendering path and browser enforcement

### The structured tree is the only artifact

```
Root: { kind: "root", children: Node[] }
Node: { kind: "el", ns: "html" | "svg", tag, attrs: [[name, value], ...], children: Node[] }
    | { kind: "text", text }
```

Nothing after validation is an HTML string. This single rule removes mutation XSS, namespace confusion on re-parse, and RCDATA context tricks (`textarea`, SVG `title` and `desc`) as a class, because there is no re-parse.

### Renderer rules

- Elements are created with `createElementNS` using the fixed namespace URI for the node's declared namespace. The tag never chooses a namespace.
- Attributes are set only with `setAttribute` for names that passed the policy. The renderer independently refuses any name matching `on*`, `style`, `src*`, `href`, `xlink*`, `xmlns*`, `srcdoc`, `formaction`, `action`, `ping`, `background`, `poster` and a few others, and any element not in the policy tables. This is the last line before the browser and it trusts nothing.
- Text is set through `Text.data`.
- Patching is positional over the validated tree. When a control's `value` or `checked` attribute is unchanged between views, the live property is left alone.

### Frame and CSP

The frame is an `iframe` with `sandbox="allow-scripts"` only, so it has an opaque origin and no access to the host's DOM, storage or credentials. Its `srcdoc` carries a `meta` CSP:

```
default-src 'none'; script-src 'sha256-<frame bundle>'; style-src 'sha256-<bundled css>';
require-trusted-types-for 'script'; trusted-types 'none'; base-uri 'none'; form-action 'none'
```

A `srcdoc` document inherits the embedding page's CSP as well, so the host page must include the same two hashes. The frame can therefore only ever be stricter than the host. Inside the frame, fixed code additionally replaces `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe`, `document.write`, `createContextualFragment` and `DOMParser` with throwing stubs, so a future bug in fixed code fails loudly in browsers without Trusted Types.

The host verifies that every message comes from the frame's window with a null origin, and applies a schema check to every event before it reaches the runtime. Events are read as own properties only.

### Typed output

```ts
type HtmlResult =
  | { status: "validated"; policyId: string; tree: StructuredTree; changes: Change[] }
  | { status: "rejected"; reasons: Rejection[] };

type JsPreparation =
  | { status: "eligible-for-restricted-execution"; program: PreparedProgram }
  | { status: "rejected"; reasons: Rejection[] };
```

A validated tree is recognizable without trusting its producer: it is a fixed point of the policy with an empty change list. The host and the frame both check this before rendering, so ordinary JSON cannot manufacture approval and persisted documents are revalidated for free.

### Properties to establish in Lean

- Successful validation produces only permitted HTML and SVG constructs.
- Validated output cannot express generated script execution, external resource requests or navigation within the defined model.
- Validation is idempotent: validated output is a fixed point.
- Event bindings remain within the permitted document interface.
- Structural limits hold for accepted output.

Be explicit about what the proofs do and do not cover. For a reconstruct-from-allowlist design the first property is nearly by construction. The historically dangerous bugs are parser differentials between the model and the browser, and those are closed by the structured tree rule in this section rather than by proof. The parser adapter, renderer, runtime bindings, compilers and browser remain implementation assumptions. Audit proof assumptions and disallow `sorry` or unapproved axioms. Validation does not clear private-data or untrusted-input labels.

## 4 Implementation and delivery

### Delivered in this repository

| Module | File | Role |
|---|---|---|
| Tree format and limits | `src/tree.js` | Structured tree, shape check |
| Policy | `src/policy.js` | Allowlists, value validators, `checkTree`, `isValidated` |
| Parser adapters | `src/adapters/dom.js`, `src/adapters/parse5.js` | Raw trees from `DOMParser` or parse5 |
| Renderer | `src/render.js` | DOM from tree, patching, focus preservation |
| Frame | `src/frame.js` | In-frame controller, sink hardening, event forwarding |
| Host | `src/host.js` | Sandboxed frame creation, CSP document, event schema |
| AST gate | `src/gate.js` | Interface and unsupported-construct diagnostics |
| Runtime | `src/runtime/core.js`, `worker.js`, `controller.js` | QuickJS execution, worker, watchdog and state ownership |
| Build | `scripts/build.mjs` | Bundles, class allowlist extraction, CSP hashes |
| Demo | `demo/` | Host page with benign and attack samples |
| Rules catalog | `rules/catalog.json`, generated `src/rules.js`, `lean/Guard/Rules.lean` | 43 rules with mechanisms, citations, proofs and verified CVE references; every change record cites one |
| Shared policy schema | `rules/policy.json`, generated JS/Lean tables and limits | One editable source for allowed elements, attributes, validator descriptors, forced values, and structural limits |
| BDD | `features/` | Cucumber scenarios tagged by rule and CVE, run against JS, Lean and Wasm in the default verification command |
| Coverage gate | `scripts/rule-coverage.mjs` | Fails `npm test` on any rule without a scenario, unknown tag, stale id or one-language citation |
| Lean checker | `lean/` | Executable specification split into Core, Validators, Policy, Props, Io; proofs; Docker toolchain; Wasm build |
| Wasm check | `scripts/wasm-check.mjs` | Loads the Wasm checker in Node and compares to the JavaScript checker |
| Differential | `scripts/lean-differential.mjs` | Lean vs JavaScript on corpus plus seeded random HTML |
| Tests | `test/` | 52 unit tests with `[R-…]` rule prefixes; `scripts/browser-check.mjs` end-to-end in Chromium and Firefox |

### Remaining work

- **Moving off the v4.15.0 pin.** No upstream Wasm build of Lean exists to reuse: lean4web runs the Lean server on a backend, not in the browser, and Lean's own CI "Web Assembly" matrix entry is commented out in `.github/workflows/ci.yml`. That commented block is the recipe: a 32-bit native stage0, then the runtime and `Init` built through Emscripten's CMake toolchain file with `USE_GMP=OFF` and `MMAP=OFF`, installed with suffix `-linux_wasm32`. Reviving it as a Dockerfile stage is the escape hatch if a newer Lean is ever needed; until then the pin costs nothing.
- **Rule attribution for rejections.** Rejection reasons carry codes (`too-deep`, `too-many-nodes`, …) but no rule id; `R-LIMIT-TREE` is therefore covered by scenarios and the catalog only. Adding `rule` to reasons in both languages is small.
- **Unreachable branch.** The "SVG element outside an svg root" branch of `R-NS-POSITION` cannot be reached through an HTML5 parser (such tags arrive as unknown HTML); it is exercised only by forged trees. Keep it as defence in depth for the frame's re-validation of postMessage trees.

- **Lean proofs.** The checker now uses total traversal and an explicit acceptance predicate plus canonical recheck. Whole-checker theorems establish policy membership for nested descendants, absence of script elements and event-handler attributes, node/text bounds, and identical revalidation with no changes. Existing validator grammar proofs remain. These results concern the guarded acceptance function, not a claim that every normalizer candidate is safe or complete. `npm test` rebuilds native/Wasm from current sources and audits advertised theorem kinds and axioms. JS equivalence, parser/JSON adapters, rendering, and browser semantics remain outside the proofs. See [verification scope](docs/VERIFICATION.md).
- **Lean to WebAssembly.** Built and measured. With runtime-only initialization, `Init`-only dependencies and a self-contained JSON module, the checker is a 1.4 MiB module that initializes in about 20 ms and agrees with the JavaScript checker on thousands of inputs. Three costs remain and are now concrete rather than speculative: the pin to v4.15.0, the last release with a prebuilt wasm32 runtime; four libuv stubs in the C shim; and a 16 MB stack setting. The original deferral reasons of size and startup no longer apply. What still applies: the proof stops at the JSON boundary, and the frame would carry a second copy of the checker. Decision: ship the Wasm checker in the host as an option behind the same `isValidated` interface, keep the JavaScript checker in the frame, and revisit the pin when a newer Lean release restores a wasm32 runtime or the runtime is built from source.
- **Host CSP integration.** Product hosts must add the frame's script and style hashes to their page policy. Provide these from the build manifest.
- **Permissions Policy.** Add an `allow` attribute on the frame that denies every feature explicitly.
- **Trusted Types coverage.** The browser check passes in Chromium and Firefox. Confirm which shipping Firefox versions enforce `require-trusted-types-for`; the sink hardening covers versions that do not.
- **Deployment as a privileged page.** If the renderer will ever live inside a privileged browser page, the frame must be a separate content process, not just a sandboxed iframe.

Pin toolchains and dependencies. Include clean-build instructions, native and Wasm equivalence checks, and a browser demonstration.

## 5 Red team evaluation

Compare the HTML guard with equivalently configured DOMPurify and hast-util-sanitize. Seed attacks from relevant sanitizer fixtures, OWASP examples and HTML parser tests. Retain corpus versions and attribution, and distinguish malicious cases from parser-correctness cases [2-6].

- Script injection, event attributes, executable URLs and malformed markup. (Unit tests cover an initial OWASP-derived set.)
- SVG namespace confusion, integration points (`desc`, `title`, `foreignObject`), embedded HTML and resource references.
- Differential parsing: the Lean or JavaScript checker's tree against a real browser parse of the same input.
- DOM clobbering corpus against the frame code, CSS containment escapes with every bundled class, autofill triggers.
- Network attempts through every permitted rendering surface and views that become malicious only after interaction.
- Forged trees, malformed events, stale responses, cross-page event references, malformed output from the worker.
- Infinite loops, excessive allocation, deep recursion, large views, complex paths and event floods. (Unit tests cover each limit.)
- Sorting, filtering, chart selection, controls, keyboard access and focus preservation on benign pages. (Browser check covers these.)

Run with request logging and controlled endpoints. Require zero outgoing requests attributable to generated content, zero CSP violations reported from inside the frame, no generated script execution in the browser realm, and validation before every displayed update. Measure content preservation, interaction correctness, rendering latency and resource usage alongside security results.

Report proof guarantees separately from observed browser-test results. Passing the policy limits permitted capabilities; it does not certify the truthfulness or intent of displayed text and graphics.

### References

1. [QuickJS Emscripten runtime and host API documentation](https://github.com/justjake/quickjs-emscripten)
2. [parse5 HTML parser](https://github.com/inikulin/parse5)
3. [DOMPurify sanitizer and configuration](https://github.com/cure53/DOMPurify)
4. [hast util sanitize AST sanitization](https://github.com/syntax-tree/hast-util-sanitize)
5. [OWASP XSS filter evasion examples](https://cheatsheetseries.owasp.org/cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.html)
6. [html5lib parser tests](https://github.com/html5lib/html5lib-tests)
