// Host bootstrap module for n1. Runs only if the policy under test permits it.
// Question 1: does the CDN module load at all, and by which mechanism.
// Question 2: does trust propagate to await import() of a cross-origin payload.
const CDN = "{CDN}";
const R = window.__result;
R.steps.bootstrapNeverRan = false;
R.steps.hostModuleRan = true;
R.steps.hostModuleHadNonceAttr = String(document.querySelector('script[src="/n1.js"]') ? "tag-present" : "tag-missing");

const err = (e) => `${e.name}: ${String(e.message).slice(0, 200)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// (a) The documented Profile A path: await import() of the cross-origin bundle
//     from an already-running host module.
try {
  const m = await import(CDN + "/cdn-module-dep.js?from=host-module");
  R.steps.dynamicImportFromHostModule = { ok: true, keys: Object.keys(m).length };
} catch (e) {
  R.steps.dynamicImportFromHostModule = { ok: false, error: err(e) };
}

// (b) The same import from a *classic* nonce'd script's context, via a
//     programmatically inserted script element with NO nonce. This is the case
//     'strict-dynamic' exists to allow.
await new Promise((resolve) => {
  const s = document.createElement("script");
  s.src = CDN + "/cdn-inserted.js";
  s.onload = () => { R.steps.programmaticInsert = "load"; resolve(); };
  s.onerror = () => { R.steps.programmaticInsert = "error"; resolve(); };
  document.head.appendChild(s);
  setTimeout(() => { if (!R.steps.programmaticInsert) { R.steps.programmaticInsert = "timeout"; resolve(); } }, 2500);
});

// (c) Programmatic insert of a cross-origin MODULE script with no nonce.
await new Promise((resolve) => {
  const s = document.createElement("script");
  s.type = "module";
  s.src = CDN + "/cdn-module-dep.js?from=inserted-module";
  s.onload = () => { R.steps.programmaticInsertModule = "load"; resolve(); };
  s.onerror = () => { R.steps.programmaticInsertModule = "error"; resolve(); };
  document.head.appendChild(s);
  setTimeout(() => { if (!R.steps.programmaticInsertModule) { R.steps.programmaticInsertModule = "timeout"; resolve(); } }, 2500);
});

// (c2) Can a MODULE recover the page nonce at runtime? document.currentScript
//      is null in a module, so the only candidate is a selector plus the IDL
//      property (the content attribute is hidden by CSP nonce-hiding). This is
//      the feasibility test for propagating a host nonce into the srcdoc frame.
R.steps.nonceRecoveryFromModule = (() => {
  const out = { currentScript: String(document.currentScript) };
  const el = document.querySelector("script[nonce]");
  out.selectorMatched = !!el;
  if (el) {
    out.idl = String(el.nonce || "");
    out.attribute = String(el.getAttribute("nonce") || "");
    out.src = String(el.src || "").slice(0, 60);
  }
  const own = document.querySelector('script[src^="/n1.js"]');
  out.ownTagIdl = own ? String(own.nonce || "") : "own-tag-not-found";
  return out;
})();

// (d) eval / new Function must stay dead under every policy tested.
try { R.steps.evalResult = String(eval("1+1")); } catch (e) { R.steps.evalResult = err(e); }
try { new Function("return 1"); R.steps.newFunction = "ok"; } catch (e) { R.steps.newFunction = err(e); }

// (e) Wasm in the document realm, for reference against docs/csp.md.
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
try { new WebAssembly.Module(bytes); R.steps.wasmSync = "ok"; } catch (e) { R.steps.wasmSync = err(e); }
try { await WebAssembly.instantiate(bytes); R.steps.wasmInstantiate = "ok"; } catch (e) { R.steps.wasmInstantiate = err(e); }

await wait(300);
document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__done = true;
