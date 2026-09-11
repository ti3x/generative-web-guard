# Policy maintenance and verification

The policy is an allowlist over a structured HTML/SVG tree. A parser creates an
untrusted tree, a normalizer reconstructs a candidate, and acceptance checks
decide whether that candidate may leave the checker. The browser still uses the
JavaScript implementation and constructs DOM directly from the accepted tree.

## What to edit

| Change | Source of truth |
|---|---|
| Add/remove an element or attribute | `rules/policy.json` |
| Change an enum, numeric range, fixed value, or size limit | `rules/policy.json` |
| Explain a restriction and link evidence | `rules/catalog.json` |
| Change a custom value grammar | JS validators in `src/policy.js` and Lean `Guard/Validators/` |
| Change traversal or acceptance semantics | `src/policy.js`, Lean `Policy/Check.lean` and `Policy/Accept.lean` |
| Add an exploit regression | A tagged scenario under `features/`, with explicit expected behavior |

`sharedGlobal` in the schema holds attributes shared by HTML and SVG; namespace
tables add their own entries. For example, `"r": ["nonNeg"]` selects the same
radius validator in both languages, and `["int", 1, 100]` specifies a bounded
integer. `["tagged", "R-...", descriptor]` assigns an explanatory rule ID.

Run `npm run gen:policy` after editing the schema and `npm run gen:rules` after
editing rule identities. Generated tables, limits, and rule IDs are checked for
staleness by `npm test`. The old independent ARIA table was removed; shared ARIA
attributes and roles now live in the schema.

The drop-rule maps determine the explanation for a removal. Permission comes
from the allowlists. Adding a drop-rule entry cannot revoke an allowed element.

Custom validator algorithms remain independent JS and Lean implementations.
Generating both from arbitrary shared executable code would expand the trusted
generator and weaken the value of independent differential checks. The shared
descriptors remove duplication of choices and parameters, not the need to review
both algorithms when their semantics change.

## Exact whole-checker guarantees

The Lean boundary is `checkTree : Ctx → List Raw → Result`. Parsing strings and
converting JSON to `Raw` happen before that boundary.

| Theorem | Guarantee for every accepted output |
|---|---|
| `accepted_policy` | The explicit output predicate holds |
| `accepted_structure` / `accepted_descendant` | All nodes, including nested descendants, satisfy the recursive predicate |
| `accepted_element_allowed` | Every descendant element is in the namespace's allowlist and has canonical attributes |
| `accepted_no_script` | No HTML or SVG `script` element occurs anywhere in the tree |
| `accepted_no_handler` | No attribute starts with `on` or contains a namespace prefix separator |
| `accepted_node_bound` / `accepted_text_bound` | Global node count and UTF-16 text size stay within configured limits |
| `accepted_idempotent` | Rechecking the output returns exactly that tree with an empty change list |

The recursive predicate also checks namespace transitions, element depth,
text-only SVG contexts, cleaned nonempty text, attribute counts, canonical
validator results, and forced control attributes.

These theorems apply to a guarded acceptance function. The normalizer uses total
recursion with decreasing fuel. Its candidate must pass the output predicate
and a second normalization. This makes acceptance sound even if a future
normalizer change produces an invalid candidate: the document is rejected.
It adds predicate evaluation and a normalization pass. It is not a proof that
normalization always succeeds or never changes a benign document unnecessarily.

The existing validator proofs cover particular grammar properties. For example,
the color proof characterizes named/hex/RGB recognizer output; it does not prove
the browser's complete CSS color semantics. A theorem must be read at its actual
type rather than inferred from its name or a catalog title.

## Verification commands

Start Docker, then prepare the toolchains once:

```sh
npm run setup:verification
```

`npm test` is the full verification command. It:

1. Checks generated rule IDs, policy tables, and limits for staleness.
2. Requires the Lean and Wasm toolchain images; missing images fail the run.
3. Builds the current Lean library, native checker, and native tests from the
   mounted working tree. It does not rely on a possibly stale checker image.
4. Resolves each advertised proof in Lean, requires it to be a theorem, and
   audits its transitive axioms. Only `propext`, `Classical.choice`, and
   `Quot.sound` are allowed; admitted proofs and custom axioms fail verification.
5. Rebuilds Wasm from the same sources, then runs unit tests and BDD scenarios
   with JS, native Lean, and Wasm explicitly required.
6. Checks independent safety assertions, an exact benign output, and fixed
   points against all three engines. Negative controls ensure the oracle rejects
   representative unsafe outputs; positive controls detect rejecting or erasing
   all content.
7. Checks rule-to-test/code traceability, clearly labeled as traceability.

`npm run test:js` is a faster, explicitly limited development command. It does
not establish that Lean compiled, proofs passed, or Wasm agreed. Individual
`check:lean`, `check:wasm`, and `check:proofs` commands assume their prerequisite
builds are current; use `npm test` for the complete source-to-test sequence.

Browser behavior still needs separate verification:

```sh
npm run build
PORT=8089 npm run serve
# In another terminal:
DEMO_URL=http://localhost:8089/ npm run check:browser
```

The current tests include a regression for a real traversal bug: separate text
nodes could exceed the node limit because only the element branch checked it.
Both normalizers now reject that input.

## Adding a newly discovered exploit

First reproduce the exact failure in the affected layer. Add a regression with
an expected result independent of implementation output, plus a benign example
that must remain useful. Decide whether the fix belongs in parsing, policy,
rendering, runtime isolation, or a dependency update.

For a policy change, update the schema or the two validator implementations,
the relevant catalog explanation, and affected proofs. Run full verification
and browser checks. Review whether the theorem statement covers the new risk;
a proof can keep compiling while an unmodeled exploit remains possible.

Cross-engine agreement cannot detect a shared policy mistake. The independent
safety oracle, known expected outputs, malformed-markup regressions, and browser
tests provide complementary evidence. The current negative controls test the
oracle against representative injected faults; they are not exhaustive mutation
testing or a claim of complete exploit coverage.

## The case for Lean, and its limits

Lean does not give the browser fewer permissions than equivalent JavaScript.
It gives a universal, mechanically checked statement about a small modeled
security boundary. Tests exercise examples; accepted-output theorems quantify
over every finite `Raw` input and every context.

This is valuable when the policy is stable enough to formalize, mistakes have
high cost, and the project can maintain explicit specifications and proofs.
For a small prototype, reviewed JS plus good tests and browser isolation may
be a reasonable tradeoff.

Today the shipping demo uses JS. Differential tests are evidence of agreement,
not a proof that Lean's theorems hold for JS. To make the proved implementation
the actual runtime authority, integrate the Lean/Wasm checker into acceptance,
or separately prove JS equivalence. Neither is included in this change.

Parser behavior and resource use, JSON adapters, renderer correctness, message
handling, QuickJS isolation, the code generators and compilers, and browser
semantics remain outside these theorems. In particular, the previously observed
deep-input adapter stack overflow and the browser DOMParser resource-loading
question are separate parser-hardening work; output proofs do not fix them.
