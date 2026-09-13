// Cross-origin ES MODULE loaded from a parser-inserted <script type="module">
// carrying the page nonce -- the shape a consumer would actually use for this
// library. It then dynamically imports a second cross-origin module to test
// whether trust propagates onward from a nonce'd cross-origin module.
window.__result.tags.cdnModuleNonced = "ran";
try {
  await import("{CDN}/cdn-module-dep.js");
  window.__result.tags.cdnModuleNoncedChainImport = "ok";
} catch (e) {
  window.__result.tags.cdnModuleNoncedChainImport = e.name + ": " + String(e.message).slice(0, 160);
}
