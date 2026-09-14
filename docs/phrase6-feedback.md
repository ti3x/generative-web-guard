# Phase 6 feedback and implementation decisions

This records the review of [phase-6-plan.md](phase-6-plan.md) and the decisions
made during planning. Backward compatibility is not a requirement for this new
library. Completion evidence is recorded in [phase6-results.md](phase6-results.md);
the decisions here do not by themselves establish implementation or verification.

## The JavaScript checker has two different jobs

JavaScript currently constructs a sanitized candidate and also runs output-policy
and replay checks. Phase 6 retains candidate construction and diagnostics in the
policy Worker, but moves the sole production acceptance decision to Lean's
candidate checker. Building a candidate successfully does not authorize rendering.

Extract a proposal-only builder that normalizes once. Keep the full JavaScript
normalizer, output predicate, and replay checker in reference/test code with their
existing semantics. Do not weaken `checkTree` and then compare the weakened
implementation to itself. A different but policy-conforming proposal can now
be accepted: semantic fidelity to the original HTML is not a candidate-checker
theorem. Keep benign-output and JS/native reference regressions for that risk.
After the proof gate passes, send the proposed tree to
Lean rather than having Lean independently sanitize the original raw tree.

The production path should be:

```text
HTML, or a view returned by the QuickJS guest
  -> bounded parse5 preprocessing
  -> JavaScript candidate and diagnostics
  -> Lean candidate acceptance
  -> private policy-Worker-to-frame port
  -> structured renderer
```

Lean must return the exact accepted tree. A bare success flag must not authorize
some other object held by the host. Configuration sealing, version checks,
bounded decoding, poisoning after a trap, deadlines, and refusal on failure stay
mandatory. There is no JavaScript acceptance fallback.

## Why remove the synchronous JavaScript exports?

| Export | Reason to remove it from the main bundles |
|---|---|
| `checkTree` | Its JavaScript-only `validated` answer cannot authorize rendering. Its useful remaining role is independent reference testing. |
| `isValidated` | It reruns the full JavaScript checker; it does not establish Lean acceptance or bind a tree to a verdict. |
| `guardHtml` | It synchronously parses and checks on the caller's thread, but still cannot authorize a render. The Lean-backed Worker APIs provide the production workflow. |

These exports cannot currently bypass acceptance through the guarded public frame
API. Removing them clarifies the API and lets unused acceptance code leave the
bundles. The actual payload reduction must be measured. Keep `createGuard` and
Lean-backed session/frame factories; no compatibility aliases or new synchronous
markup-diagnostics bundle are needed.

## What the legacy parent-message route means

Before a private port is bound, the current iframe accepts a parent `postMessage`
containing a tree. The old host `frame.render(...)` method uses that route. The
frame runs `isValidated(tree)` because the message alone does not establish Lean
acceptance. Deleting that check while retaining the route would remove the policy
check on those inputs; renderer assertions do not implement the complete policy.

The chosen design removes the route. An unbound frame is inert. Parent messages
can bootstrap a port but cannot supply a tree to render, even before bootstrap or
after Worker replacement. Remove host-side `frame.render`, queued trees, and
acceptance-record claiming as a way to commit. Create the frame first, then bind
it to a policy session; an attached session resolves with `rendered` only after
the frame acknowledges that request. Clearing goes through the accepted empty
document path.

Keep structural message checks, instance/session/request identity, sequence and
replay defenses, and the renderer's own construction assertions. A private port
is trusted transport, not a proof: the trusted policy Worker must send only the
tree Lean accepted. The host and transport remain outside the Lean theorems.

Migrate the showcase, CDN example, browser probes, and test harnesses. Preserve
the showcase editor and diagnostics. Its sanitized-markup preview can be a bounded
diagnostic string produced from the accepted tree in the Worker; it must not add
a way to submit a host-supplied tree or string to the frame.

## Why no mandatory JavaScript AST denylist?

The optional JavaScript AST linter is a separate concern from the JavaScript
implementation of the HTML/SVG policy. Generated programs run in bounded QuickJS
confinement, with no exposed DOM, network, filesystem, or host capabilities.
QuickJS parses the program, while the runtime enforces its interface, memory,
stack, serialization, and execution budgets. Every resulting view still passes
through Lean's markup acceptance path.

HTML needs structural and attribute validation because its accepted tree becomes
browser DOM. Guest JavaScript is constrained through its execution environment.
An identifier denylist cannot establish confinement: aliases, computed accesses,
and dynamic evaluation can express operations without a forbidden spelling.

Keep the optional linter as authoring diagnostics and preserve confinement tests
with it bypassed. Do not add a mandatory AST acceptance pass in phase 6. Lean's
markup theorems do not prove QuickJS confinement or browser behavior.

## Proof, build, and verification order

1. Capture the current bypass-test and browser-performance baseline before
   changing production acceptance.
2. Develop the candidate checker alongside the full reference normalizer. Make
   canonical names, unique sorted attributes, canonical validator results,
   required controls, recursive contexts, and resource accounting explicit.
3. Prove the concrete accepted-output invariants and the connection to unchanged
   reference normalization before removing replay. Preserve profile validity and
   output-restriction guarantees. Keep advertised proofs in the catalog-backed
   axiom audit; no admitted proofs, custom axioms, or `native_decide` shortcuts.
4. Version the candidate-only ABI, switch the Worker to candidate input, and then
   remove duplicate JavaScript acceptance and the legacy frame route.
5. Build Wasm from a production root containing only the candidate authority and
   necessary dependencies. Merely changing exports is insufficient while the
   broad `Guard` initializer still reaches the reference/test modules.
6. Evaluate deterministic gzip-before-base64 embedding separately. Ship it only
   if transfer size improves without a repeatable startup or peak-memory
   regression, and startup, CSP, and failure checks pass on all supported engines.

Tests must exercise malformed and unsafe candidates directly, without a hidden
normalization pass. Keep independent safety expectations, exact benign outputs,
JS/native-Lean reference comparison, and candidate-to-reference agreement. Frame
test doubles must not secretly run the removed JavaScript acceptance checks.

Run fresh full verification, the axiom audit, generated-file checks, reproducible
distribution builds, CDN checks, and separate Chromium/Firefox/WebKit browser
checks. Include transformed candidate shapes, especially unwrapping that expands
sibling width, repeated maximum-size requests, authority failures, and Worker
replacement. Keep preprocessing limits unless fresh measurements justify a
change. Record actual passes, failures, and skips; do not infer browser cost or
noninterference from termination or structural proofs.
