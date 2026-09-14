# Frequently asked questions

## 1. Why use Lean 4 instead of JavaScript tests and assertions?

Lean adds mechanically checked evidence about the policy checker. Equivalent
JavaScript can enforce the same restrictions; Lean does not grant extra browser
security capabilities.

There are three different kinds of assurance:

| Mechanism | What it establishes |
|---|---|
| Tests | The selected inputs produced the expected results. |
| Runtime assertions | Each executed check passed for this particular candidate output, assuming the assertion and execution are correct. |
| Lean proofs | Every accepted candidate satisfies the stated properties; reference-checker theorems also cover accepted outputs across finite raw-tree inputs. |

We use all three. JS proposes output; production acceptance is Lean-only. Full JS and Lean
normalizers remain reference tools. Lean proves consequences of acceptance: allowed elements,
no script elements or event-handler attributes anywhere in the tree, bounded
node/text counts, and unchanged output when checked again. Lean's kernel checks
the proofs; our verification command also audits their axioms. See
[Lean's proof-validation documentation](https://lean-lang.org/doc/reference/latest/ValidatingProofs/).

The current design proves a guarded acceptance function: a candidate must pass
an output predicate and canonical representation checks. A separate theorem
proves it would pass the full reference normalizer unchanged; production does
not run that second normalization. This does not prove that the
normalizer always succeeds, preserves every benign document, or implements a
complete model of browser security. An assertion that merely restates a weak
policy is still weak, even when acceptance implies it by a proved theorem.
The useful part is specifying and proving concrete security properties.

Lean is a reasonable investment when a small, maintained policy boundary needs
strong assurance through future changes. Reviewed JavaScript, runtime checks,
adversarial tests, and isolation can be a reasonable choice without Lean too.
The tradeoff is proof-maintenance work and a second implementation.

**What the browser actually runs:** the demos and the CDN bundles now use the
Lean checker compiled to WebAssembly as the acceptance authority, so the
implementation the theorems are about is the one that decides. The JavaScript
checker still runs beside it as a candidate builder and a diagnostics source.
Lean accepts or refuses that candidate without independently normalizing the
original HTML or comparing two outputs. Missing, failing, rejecting, malformed or
timed-out Lean never falls back to JavaScript acceptance: the library refuses
to render.

**Current limitation:** that is still not a proof of JS equivalence, and
differential tests never were one. Everything around the checker is outside the
proofs — parsing, the JSON codec, the C shim, the Emscripten runtime, the
trusted glue, rendering, compilers, QuickJS and browser behavior — and the
resource bounds that keep the checker inside an engine's call stack are
measurements, not theorems. Exact theorem scope is in
[VERIFICATION.md](VERIFICATION.md).

## 2. Why isn't DOMPurify alone sufficient for this use case?

DOMPurify is an established XSS sanitizer, and it can be appropriate for
displaying untrusted rich text. Our requirements extend beyond removing XSS:
we want generated interfaces with restricted network access, navigation,
styling, host access, and separately isolated interaction code.

For example, an ordinary HTTPS image or link need not be an XSS attack, but it
still permits a resource request or navigation that our policy excludes. The
guard therefore removes resource-loading surfaces, unwraps links and forms,
restricts styling to bundled classes and validated SVG values, and reconstructs
the accepted tree with DOM constructors.

The full integration adds protections outside a sanitizer's responsibility:

- A null-origin iframe and restrictive CSP isolate rendered content from the
  host page. The host CSP is documented and cross-engine tested in
  [csp.md](csp.md), including the two places engines diverge: Trusted Types is
  absent on Firefox 141, and WebKit 26 does not gate every Wasm entry point.
- The frame receives trees only through the private policy Worker port and
  checks its renderer construction contract, without repeating policy checks.
- Generated JavaScript runs in QuickJS/Wasm in a Worker, with restricted
  capabilities and resource limits. There is no mandatory static denylist: the
  runtime has no DOM, network, storage, timers or module loader to reach.
- Every view returned by that JavaScript goes through the markup policy before
  it can be rendered.

Use `createGuard` to assemble those boundaries. The synchronous JS-only
`guardHtml` export has been removed.

DOMPurify can be configured with restrictive allowlists and can return DOM
nodes or fragments; it is not inherently limited to producing strings.
Its documentation also warns that later transformations can invalidate
sanitization. Our constructor-based rendering avoids serializing accepted
markup and parsing it again as part of the rendering path.
See [DOMPurify's documentation](https://github.com/cure53/DOMPurify).

A carefully configured DOMPurify-based design could use similar isolation and
runtime controls. We are choosing an explicit structured-tree policy with a
Lean reference and integrated containment. We have not established that this
prototype is generally more secure than DOMPurify, and historical DOMPurify CVEs
do not by themselves establish that claim.

## 3. How does this protect against newly discovered exploits and CVEs?

**It cannot guarantee protection against every future exploit.** It reduces
the available attack surface, applies multiple boundaries, and provides a
process for investigating new findings.

The allowlist rejects elements and attributes that have not been explicitly
permitted. A new exploit requiring an excluded capability, such as a particular
SVG reference element, may already be blocked without adding its payload to a
denylist. Constructor-based rendering avoids a class of reparse problems, while
the iframe, CSP, and isolated runtime provide additional containment.

Those protections depend on their implementation and assumptions. A new bug in
an allowed feature, parser, renderer, QuickJS, or browser can still matter.
Output-tree bounds do not establish bounded work before the tree is checked.
The parse5 frontend now bounds that work itself - source length before
parsing, then iterative conversion under node, depth, attribute, name, text
and byte limits, with Worker termination for parser time - but those are
tested limits, not proved ones, and the browser DOMParser resource-loading
question remains separate parser-hardening work. A proof can continue compiling
while an exploit outside its specification remains possible.

Our response process is:

1. Discover and triage reports. The configured weekly
   [advisory scout](../.github/workflows/security-scout.yml) searches recently
   published GitHub-reviewed advisories and proposes candidates in an issue.
   It is a bounded, keyword-based scan, not comprehensive CVE monitoring or a
   determination that this project is affected. It needs to be enabled on the
   repository's default branch. LLM review is an optional design, not currently
   implemented.
2. Verify the source, affected versions, and necessary conditions. Determine
   which boundary needs a fix; not every CVE calls for a new HTML rule.
3. Add a minimal regression with explicit security expectations and a benign
   preservation case. The [red-team corpus](../red-team/corpus.json) complements
   the existing CVE scenarios, independent assertions, and browser checks.
   A CVE-inspired reconstruction is not necessarily a reproduction of the
   original upstream vulnerability.
4. Update policy, dependencies, implementation, or proofs as appropriate. Full
   `npm test` builds Lean and Wasm, audits proofs, and exercises all three
   checkers. Browser checks verify the integrated rendering behavior separately.
5. Rebuild and release the affected artifacts. Consumers using a pinned CDN
   version must update their pin to receive the fix.

The defensible claim is that we enforce a narrow policy and verify specific
properties while continuously adding evidence and fixes. Neither passing tests
nor Lean proofs establish immunity to unknown attacks. See
[RED_TEAMING.md](RED_TEAMING.md) for the intake workflow.
