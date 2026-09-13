---
name: guard-policy-maintenance
description: Maintain Generative Web Guard policy, JS/Lean validators and proofs, and exploit regression coverage. Use for changes to the security checker or investigation of an advisory's impact on this repository.
---

# Policy and regression maintenance

Work from the repository root. Read `docs/VERIFICATION.md` for exact theorem
scope and the source-of-truth map. For advisory intake, also read
`docs/RED_TEAMING.md` and the relevant existing `features/` scenarios.

## Select the affected boundary

Distinguish parsing and adapters, raw-tree policy, DOM rendering, JS syntax
gating, QuickJS isolation, and host/frame messaging. A parser crash before
`checkTree` is not repaired by an accepted-output proof. Keep a reproduction at
the failing boundary; do not translate away the bug just to fit a tree fixture.

For a CVE, verify the primary source, affected versions, and exploit conditions.
Distinguish an exact reproduction from a related attack-class reconstruction.
Record provenance honestly; do not mark a source as reviewed solely because a
URL is present. Do not execute downloaded exploit programs as a discovery step.

## Change the policy deliberately

Use `rules/policy.json` for allowlists, forced attributes, validator descriptors,
and limits. Drop-rule maps label removals; adding a drop-rule entry does not
revoke an element still present in an allowlist. Use `rules/catalog.json` for
rule statements and evidence. Regenerate the associated tables and IDs.

`rules/capabilities.json` is the reviewed capability kernel and bounds every
profile. A profile edit may only restrict it: enumerations by set inclusion,
integer ranges by interval inclusion, number lists by a smaller bound, and
every other grammar by exact identity. Introducing an identity, widening a
grammar, raising a ceiling or dropping a mandatory control is a *kernel*
change: review browser effects, renderer assumptions, tests and proof scope,
then increment `capabilityVersion` and update its `meaning`. `npm run
check:policy` rejects an out-of-bounds profile on the profile data alone, so
do not rely on a corpus case to catch one. The Lean certificate
(`Guard.Props.default_profile_valid`) and the kernel's own consistency
condition (`Guard.Props.caps_consistent`) are decided at build time.

Custom validator algorithms remain separate in JS and Lean. When semantics
change, inspect both implementations and their callers. Shared tables do not
establish algorithm equivalence. Maintain namespace transitions, canonical
attributes, and acceptance/replay checks unless the task explicitly changes
that contract.

Lean's current guarantees concern guarded acceptance. Inspect the actual
theorem types in `lean/Guard/Props/Checker.lean` and output predicate in
`lean/Guard/Policy/Accept.lean`. Do not weaken a property or add admitted proofs,
custom axioms, or `native_decide` to make verification pass. If the intended
policy changes a theorem's meaning, explain and update that specification.

Lean/Wasm is the production acceptance authority, so a change to `checkTree`
semantics changes what the browser renders. Two things follow. First, the
single-document ABI (`lean/Guard/Io/Abi.lean`) versions the wire contract and
the checker identity: a semantic change needs `capabilityVersion` or
`abiVersion` moved, or the glue will happily use a module that no longer means
what the JavaScript expects. Second, the checker recurses once per sibling on
the engine's own call stack, so any change that deepens that recursion needs
the per-engine node bound re-measured (`scripts/wasm-audit.mjs`, then the
browser check) -- see docs/csp.md. Never add a fallback to JS acceptance for a
Lean failure; refusing to render is the correct behaviour.

The strict ABI decoder (`lean/Guard/Io/Decode.lean`) refuses rather than
repairs, and `Guard.rawFromJson` does the opposite and is documented as such.
Keep them apart: the lenient one is for the batch differential tool, and moving
either behaviour into the other is a security change.

## Produce evidence

Add a minimal regression with a security expectation independent of current
output and a useful benign preservation case. The current JSON red-team runner
expects validated outputs with preserved text; rejection and resource-limit
cases belong in suitable unit/BDD tests or require an intentional harness
extension. Add relevant rule/CVE tags when justified.

Run `npm test` for policy, validator, or proof changes. It rebuilds current Lean
and Wasm and rejects missing toolchains. A JS-only run is a useful iteration
check but does not substitute for it. Changes that affect parsing, rendering,
messaging, or runtime integration also need the relevant browser checks.
Rebuild committed CDN output when shipped sources change.

Explain the behavior fixed, evidence added, and remaining scope. A scenario
tag proves traceability, cross-engine agreement can hide shared mistakes, and
accepted-output proofs do not establish browser security or exploit completeness.
