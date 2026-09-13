// Host bootstrap module for n2. Question 3, 4 and 6: what a blob: Worker
// inherits from a nonce policy, whether a worker source directive is still
// required, and whether 'wasm-unsafe-eval' still works next to
// 'strict-dynamic'.
//
// A blob: Worker has NO script tag, so it cannot carry a nonce. Both outcomes
// are a priori plausible: the blob is the worker's top-level script and might
// be exempt, or the inherited nonce policy might match nothing and kill it.
const CDN = "{CDN}";
const R = window.__result;
R.steps.bootstrapNeverRan = false;
R.steps.hostModuleRan = true;
const err = (e) => e.name + ": " + String(e.message).slice(0, 200);

// Self-contained classic worker: probes everything that does not need an
// import, so its result is not confounded by the import question.
const CLASSIC_SRC = [
  'self.postMessage({type:"top-level", href:String(self.location.href).slice(0,120)});',
  'var bytes = new Uint8Array([0,97,115,109,1,0,0,0]);',
  'var out = {type:"probe"};',
  'var e2 = function (e) { return e.name + ": " + String(e.message).slice(0,160); };',
  'try { new WebAssembly.Module(bytes); out.wasmSync = "ok"; } catch (e) { out.wasmSync = e2(e); }',
  'try { new Function("return 1"); out.newFunction = "ok"; } catch (e) { out.newFunction = e2(e); }',
  'try { out.evalResult = String(eval("1+1")); } catch (e) { out.evalResult = e2(e); }',
  'var jobs = [];',
  'jobs.push(WebAssembly.compile(bytes).then(function(){out.wasmCompile="ok";},function(e){out.wasmCompile=e2(e);}));',
  'jobs.push(WebAssembly.instantiate(bytes).then(function(){out.wasmInstantiate="ok";},function(e){out.wasmInstantiate=e2(e);}));',
  'jobs.push(fetch(' + JSON.stringify(CDN + "/tiny.wasm") + ').then(function(r){out.fetchCdn="status "+r.status;},function(e){out.fetchCdn=e2(e);}));',
  'jobs.push(new Promise(function(resolve){',
  '  try {',
  '    var u = URL.createObjectURL(new Blob(["self.postMessage(1);self.close();"],{type:"text/javascript"}));',
  '    var w = new Worker(u);',
  '    w.onerror = function(ev){ out.nestedBlobWorker = "error: " + String(ev.message||ev.type); resolve(); };',
  '    w.onmessage = function(){ out.nestedBlobWorker = "ok"; try{w.terminate();}catch(x){} resolve(); };',
  '    setTimeout(function(){ if(!out.nestedBlobWorker){out.nestedBlobWorker="timeout";} resolve(); }, 900);',
  '  } catch (e) { out.nestedBlobWorker = e2(e); resolve(); }',
  '}));',
  'Promise.all(jobs).then(function(){ self.postMessage(out); });',
].join("\n");

// Module worker that dynamically imports the cross-origin payload.
const MODULE_SRC = [
  'self.postMessage({type:"top-level", href:String(self.location.href).slice(0,120)});',
  'try {',
  '  await import(' + JSON.stringify(CDN + "/worker-payload.js") + ');',
  '  self.postMessage({type:"probe", dynamicImport:"ok"});',
  '} catch (e) {',
  '  self.postMessage({type:"probe", dynamicImport: e.name + ": " + String(e.message).slice(0,200)});',
  '}',
].join("\n");

function collect(label, source, options) {
  return new Promise((resolve) => {
    const rec = { label, created: null, events: [], topLevelRan: false, probe: null, errorEvent: null };
    let url = null;
    let w = null;
    try {
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      w = new Worker(url, options);
      rec.created = "ok";
    } catch (e) {
      // Chromium throws synchronously when the applicable worker source
      // directive refuses blob:.
      rec.created = err(e);
      if (url) URL.revokeObjectURL(url);
      return resolve(rec);
    }
    const finish = () => {
      try { w.terminate(); } catch (e) { /* ignore */ }
      if (url) URL.revokeObjectURL(url);
      resolve(rec);
    };
    w.onmessage = (e) => {
      rec.events.push(e.data && e.data.type);
      if (e.data && e.data.type === "top-level") { rec.topLevelRan = true; rec.href = e.data.href; }
      if (e.data && e.data.type === "payload-imported") rec.payloadImported = true;
      if (e.data && e.data.type === "probe") { rec.probe = e.data; finish(); }
    };
    w.onerror = (e) => {
      // Firefox and WebKit report a refused blob: Worker only as an opaque
      // error event.
      rec.errorEvent = String((e && e.message) || (e && e.type) || "error");
      if (!rec.probe) finish();
    };
    setTimeout(() => { if (!rec.probe) { rec.timedOut = true; finish(); } }, 6000);
  });
}

R.steps.blobClassic = await collect("blob-classic", CLASSIC_SRC, {});
R.steps.blobModule = await collect("blob-module", MODULE_SRC, { type: "module" });

// Contingency: can a worker be given the host's nonce? There is no API for it
// -- recorded so the report can say so from an observation rather than a claim.
R.steps.workerNonceApi = typeof Worker !== "undefined" && "nonce" in Worker.prototype ? "Worker.prototype.nonce exists" : "no nonce option on Worker";
R.steps.nonceReadable = window.__nonce ? window.__nonce.slice(0, 8) + "..." : "none";

document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__done = true;
