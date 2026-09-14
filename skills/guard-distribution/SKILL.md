---
name: guard-distribution
description: Maintain Generative Web Guard browser bundles, CDN entry points, packaging, and build CI. Use when changing distribution artifacts or preparing a release, rather than for ordinary policy design or documentation edits.
---

# Browser distribution maintenance

Work from the repository root. Inspect `scripts/build.mjs`, `package.json`,
`src/cdn.js`, `src/cdn-full.js`, and `.github/workflows/build.yml` for the current
distribution contract. Read the README's CDN and host-integration sections.

## Preserve the artifact contract

`cdn/` is committed for GitHub-backed CDN consumers. `dist/` is ignored local
output; GitHub Actions uploads it for inspection. Workflow artifacts do not
become jsDelivr GitHub URLs. Generate bundles from source rather than editing
minified output. Keep frame script/style hashes synchronized with their exact
bytes and avoid build timestamps that make identical sources produce diffs.

The small ESM bundle includes bounded markup preprocessing, port-only frame and
session factories, the frame manifest and ABI constants. JS acceptance exports
are absent; candidate construction runs in the policy Worker. The full bundle also embeds the QuickJS
Worker source and the policy Worker source, and the policy Worker payload
embeds the **candidate-only Lean checker binary as base64** -- that is why it is megabytes.
Embedding is deliberate: a fetched `.wasm` would need `connect-src` in the host
policy, and the adopted profile ships `connect-src 'none'`. `npm run build`
refuses to run without `lean/wasm/dist/guard.wasm`, and there is no
JavaScript-only bundle variant because one could not render anything.

`cdn/asset-manifest.json` records the sha256 and size of every shipped
artifact. `npm run check:cdn` recomputes them, so a rebuilt checker with a
forgotten bundle fails. Those hashes bind build contents and detect mismatch;
they do not prove provenance.

Preserve browser-resolvable imports and package entry points; an import
succeeding in Node alone does not validate browser use.

## Check integration risks

Worker construction from a CDN has cross-origin constraints. The full bundle
uses a Blob URL; validate Worker startup, cleanup, runtime initialization, and
an interaction when changing that path. Check the embedding page's CSP,
including Worker/Wasm requirements, and the frame's script/style hashes.
Do not relax isolation merely to make a demonstration load.

When publishing bundled dependencies, inspect their licenses and bundled
notices. Do not choose a project license or remove the package's private flag
without the user's intent supporting that change. Pin release examples to an
actual tag or commit, or mark owner/version placeholders explicitly.

## Validate and hand off

Run `npm run build` and `npm run check:cdn`. For build-script changes, compare
artifact hashes across two builds to check reproducibility. Use browser checks
for entry-point, Worker, or CSP changes; test from a different origin when the
claimed behavior is CDN loading. Existing smoke tests do not exercise every
integration path.

Run JS checks for distribution/runtime changes and full `npm test` when checker
or proof behavior is affected. Anything that touches the embedded checker needs
`npm run wasm:build` first, then `npm run build`, `npm run check:cdn` and the
three-engine browser check -- the Worker payload is where the checker actually
has to instantiate, and Node cannot tell you whether it will. Report any
untested deployment path rather than implying local smoke tests prove a public
release works.

Include regenerated CDN files with their source changes when commits are
requested. Release preparation does not itself authorize a push, tag, package
publication, or changes to repository settings.
