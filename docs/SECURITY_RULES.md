# Security rules, BDD scenarios, and CVE regressions

`rules/catalog.json` is the source of truth for the threats the system claims
to address. Each rule has an id such as `R-EXEC-SCRIPT`, a class, a
given/when/then statement, enforcing mechanisms, code citations in both
languages, applicable Lean theorems, and verified references. CVE references
include the advisory URL and the sanitizer configuration required by the
original attack.

## Traceable rule identities

Rule ids are first-class in both reference checkers. Every policy change record
carries a `rule`, and the differential compares those ids. Tests can therefore
assert not only that a `<script>` element disappeared, but that the specific
script-removal rule caused it.

`scripts/gen-rules.mjs` generates `src/rules.js` and
`lean/Guard/Rules.lean` from the catalog. Edit the catalog, not those generated
files. `npm test` runs the generator in `--check` mode.

## Gherkin scenarios

`features/*.feature` contains one file per rule class plus
`cve-regressions.feature`. Tags such as `@rule:R-…` and `@cve:CVE-…` connect
scenarios to the catalog. Policy scenarios run `When every engine validates
it` and finish with `Then all engines agree`, making each scenario a
JavaScript/native-Lean/Wasm differential. Runtime, linter, frame, and renderer
rules have JavaScript-only scenarios using QuickJS and jsdom.

```sh
npm run test:bdd
GUARD_LEAN_MOUNT=1 ENGINES=js,lean,wasm npm run test:bdd
```

The second command fails if any requested engine is unavailable; it does not
silently downgrade the comparison.

## Coverage gate

`npm run test:coverage`, included in `npm test`, reports rule, class, engines,
scenario count, unit tests, citations in each language, proofs, and CVE
references. It fails on:

- a rule without a scenario or a scenario without a rule tag;
- unknown rule or CVE tags;
- a catalog CVE without a matching scenario;
- stale generated rule ids;
- a rule cited in only one language; or
- a cited file that does not exist.

Unit-test titles use `[R-…]` prefixes so they can be traced to the same catalog.

## Modeled CVEs

- DOMPurify: CVE-2019-16728, CVE-2020-26870, CVE-2024-45801,
  CVE-2024-47875, CVE-2024-48910, CVE-2025-26791
- bleach: CVE-2020-6802, CVE-2020-6816, CVE-2020-6817, CVE-2021-23980
- rails-html-sanitizer: CVE-2022-32209 and CVE-2024-53985 through
  CVE-2024-53989
- Loofah: CVE-2018-8048

Each recorded CVE was checked against its GitHub advisory. Rules without a CVE
cite a technical write-up or browser behavior instead; the catalog does not use
unverified CVE ids.

The weekly advisory scout is a bounded intake aid, not comprehensive CVE
coverage and not an automatic policy updater. It scopes candidates to HTML,
SVG, JavaScript sandbox/parser concerns, and directly relevant packages, then
deduplicates the triage issue. See [red-team intake](RED_TEAMING.md) for the
review workflow.
