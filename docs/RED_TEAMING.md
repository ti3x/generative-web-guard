# Red-team intake and regression process

Security examples belong in `red-team/corpus.json` when they exercise the
HTML/SVG tree boundary. Each entry records provenance, the date a human checked
the source, implicated rule IDs, hostile markup, and safe text that must remain.
The generic test rejects active elements, event/resource attributes, scriptable
URLs, unknown rule IDs, duplicate case IDs, and loss of the expected benign
content. The behavioral property runner sends the same corpus through JS,
native Lean, and Lean/Wasm during full verification.

An exploit report should become a test only after a maintainer verifies the
primary advisory and reduces it to a non-networking fixture. Use
`attacker.invalid` for any illustrative endpoint. Record what must be removed
and what useful content must survive; a test that merely accepts total deletion
is weak evidence. Parser crashes, excessive resource use, renderer problems,
JS-gate bypasses, and QuickJS problems need tests at their own boundary rather
than being forced into the tree corpus.

## Weekly advisory scout

`.github/workflows/security-scout.yml` runs each Monday and can also be started
manually. It queries GitHub's reviewed global Security Advisory Database for the
previous 30 days. A deterministic relevance score looks for sanitizer/parser
packages, HTML/SVG/MathML and mutation-XSS language, relevant CWEs, and resource
exhaustion. Advisories already present in an earlier `security-scout` issue are
excluded. If no new candidates remain, the workflow writes nothing.

The workflow has `contents: read` and `issues: write`; it cannot edit policy or
tests. External advisory descriptions are used only for matching. The issue
contains bounded, escaped summaries and GitHub advisory links, followed by a
human triage checklist. Run the report locally only with an explicit token and
repository:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=OWNER/generative-web-guard \
  SCOUT_DRY_RUN=1 npm run security:scout
```

## Optional agent review

GitHub Models itself was retired in July 2026. GitHub Agentic Workflows are the
current GitHub-native route for adding Copilot, Codex, Claude, or Gemini analysis.
An agent can usefully rank the deterministic candidate list, compare advisories
with `rules/catalog.json`, and propose test ideas. Keep its safe output limited
to an issue or issue comment. It should have no content-write or pull-request
permission, and its report must retain the primary links because advisory text
can contain prompt injection.

Agentic Workflows require choosing an engine and authentication method, then
compiling both the Markdown source and generated lock workflow with `gh aw`.
That optional layer is intentionally separate: advisory collection and issue
creation work without an LLM, credentials, or model availability.
