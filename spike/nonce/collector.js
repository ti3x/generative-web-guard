// Loaded FIRST on every harness page, as a classic same-origin script carrying
// the page's nonce. It is allowed both under Profile A ('self') and under every
// nonce policy tested ('nonce-...'), so the recording apparatus survives even
// when the thing under test is refused.
//
// It also answers a question of its own: whether the page's nonce is readable
// at runtime from script (document.currentScript.nonce), which is the only way
// a library could ever propagate a host nonce into anything it creates.
(function () {
  var R = {
    page: location.pathname,
    search: location.search,
    violations: [],
    consoleNote: [],
    // Observed: is the nonce readable by script at all?
    nonceViaIdl: null,
    nonceViaAttribute: null,
    tags: {},
    steps: {},
  };
  try {
    var me = document.currentScript;
    R.nonceViaIdl = me ? String(me.nonce || "") : "no-currentScript";
    R.nonceViaAttribute = me ? String(me.getAttribute("nonce") || "") : "no-currentScript";
  } catch (e) {
    R.nonceViaIdl = "throw: " + e.name;
  }
  window.__nonce = R.nonceViaIdl && R.nonceViaIdl.length > 4 ? R.nonceViaIdl : "{NONCE}";
  window.__result = R;
  window.__done = false;
  document.addEventListener("securitypolicyviolation", function (e) {
    R.violations.push({
      effectiveDirective: e.effectiveDirective || e.violatedDirective,
      blockedURI: String(e.blockedURI).slice(0, 160),
      sample: String(e.sample || "").slice(0, 60),
      sourceFile: String(e.sourceFile || "").slice(0, 120),
    });
  });
  // Fallback completion. If the page's own bootstrap script never runs -- which
  // is one of the outcomes under test -- the driver still gets a clean record
  // instead of a timeout. It must NOT fire while a bootstrap that did run is
  // still working through its own per-stage waits, so it only short-circuits
  // the "script never ran" case; a 22 s absolute stop covers everything else
  // and stays inside the driver's budget.
  window.__hardStop = setTimeout(function () {
    if (!window.__done && !R.steps.hostModuleRan) {
      R.steps.bootstrapNeverRan = true;
      R.timedOutByCollector = "bootstrap-never-ran";
      window.__done = true;
    }
  }, 6000);
  window.__absoluteStop = setTimeout(function () {
    if (!window.__done) {
      R.timedOutByCollector = "absolute-stop";
      window.__done = true;
    }
  }, 40000);
})();
