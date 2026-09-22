# Repository architecture

This map identifies the source of truth for the policy, the production trust
boundary, generated files, verification tooling, and browser integration.

| Path | Purpose |
|---|---|
| `rules/catalog.json` | Security rules: id, class, statement, mechanisms, citing code, proofs, and CVE references |
| `rules/policy.json` | Editable shared HTML/SVG tables, validator descriptors, forced values, and limits |
| `rules/capabilities.json` | Reviewed capability kernel that bounds every policy profile |
| `src/policy-data.js` | Generated JavaScript policy tables and limits |
| `src/rules.js`, `lean/Guard/Rules.lean` | Generated rule ids; do not edit |
| `features/` | Cucumber features tagged `@rule:`/`@cve:`, step definitions, and engine hooks |
| `red-team/corpus.json` | Reviewable hostile-input corpus with provenance, rule links, and preservation expectations |
| `src/tree.js` | Tree format and structural limits |
| `src/policy.js` | Validator algorithms and proposal builder; full `checkTree`/`isValidated` retained for reference tests |
| `src/adapters/parse5.js` | Production HTML frontend: bounded, iterative parse5-to-raw-tree conversion |
| `src/adapters/dom.js` | `DOMParser` adapter retained only for parser-differential compatibility tests |
| `src/policy-protocol.js` | Policy Worker protocol, message envelope, and preprocessing limits |
| `src/policy-core.js` | Worker-side preprocessing, candidate construction, and Lean/Wasm acceptance |
| `src/lean-abi.js` | Versioned single-document ABI, strict response validation, and version/bounds constants |
| `src/lean-checker.js` | One sealed WebAssembly instance; poisons itself on a trap and never falls back |
| `src/lean-module.js` | Self-contained Emscripten factory and embedded checker binary |
| `src/acceptance.js` | Verdict identity records; retired registry retained only as a reference/test utility |
| `lean/Guard/Policy/Candidate.lean` | Production output-policy and canonical-representation acceptance |
| `lean/Guard/Props/CandidateReplay.lean` | Proof that candidate acceptance implies unchanged full-reference acceptance |
| `lean/Guard/Io/Abi.lean` | Strict production configure/check ABI and exported Wasm operations |
| `lean/Guard/Wasm.lean` | Minimal production import root, excluding normalization, batch IO, and proofs |
| `src/policy-worker.js` | Policy Worker entry; never executes generated JavaScript |
| `src/policy-dispatcher.js` | Shared policy request/session dispatch used by the Worker and test doubles |
| `src/policy-client.js` | Host session: identity, generation, request ids, timeouts, and termination |
| `src/render.js` | DOM construction and patching from an accepted tree |
| `src/frame.js` | Code inside the sandboxed frame |
| `src/host.js` | Sandboxed-frame creation, event schema, and frame-bootstrap startup stage |
| `src/startup.js` | Per-stage startup budgets, error codes, and `blob:` Worker creation |
| `src/gate.js` | Optional development linter; diagnostic only and never authorization |
| `src/runtime/` | QuickJS core, Worker entry, and host-side controller |
| `scripts/build.mjs` | Bundles, CSP hash manifest, embedded checker binary, and deterministic asset manifest |
| `scripts/wasm-audit.mjs` | Checker heap, linear-stack, and memory-growth measurements |
| `scripts/browser-check.mjs` | End-to-end browser verification |
| `scripts/lib/engines.mjs` | JavaScript, native Lean, and Wasm engines used by differential and Cucumber tests |
| `scripts/lean-differential.mjs` | Native Lean checker versus `policy.js` differential fuzzer |
| `scripts/rule-coverage.mjs` | Traceability gate over catalog, features, unit titles, citations, and proofs |
| `scripts/check-proofs.mjs` | Resolves advertised Lean theorems and audits their transitive axioms |
| `scripts/check-policy-properties.mjs` | Independent output assertions, positive examples, fixed points, and negative controls |
| `scripts/security-scout.mjs` | Weekly scoped Advisory Database filter and deduplicated triage report |
| `docs/csp.md` | Host CSP profiles, tested browser matrix, and startup error codes |
| `docs/VERIFICATION.md` | Rule-maintenance workflow, exact proof scope, and why Lean is useful |
| `docs/RED_TEAMING.md` | Hostile-input intake, advisory scout, and optional agent-review design |
| `scripts/gen-rules.mjs` | Generates rule-id files from the catalog; `--check` runs in `npm test` |
| `lean/` | Lean 4 executable specification, proofs, and Docker build |
| `demo/` | Host page with benign and attack samples |

Generated files must be regenerated from their owners rather than edited by
hand. See [verification](VERIFICATION.md) for the maintenance workflow and
[the Lean checker](LEAN_CHECKER.md) for its production/test split.
