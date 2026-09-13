// Capability probe that runs unchanged as a classic worker, a module worker, a
// blob worker, a data: worker, or imported by a shim worker. The CDN origin is
// passed in through the Worker `name` option so the same source text works in
// every case without server-side templating.
(function () {
  // `name` carries either the CDN origin or a JSON envelope {url, cdn}.
  var CDN = (typeof self !== "undefined" && self.name) || "";
  try { var envelope = JSON.parse(CDN); if (envelope && envelope.cdn) CDN = envelope.cdn; } catch (e) {}
  var res = {
    type: "probe-result",
    href: String(self.location && self.location.href).slice(0, 160),
    origin: String(self.location && self.location.origin),
    isWorker: typeof WorkerGlobalScope !== "undefined",
    cdn: CDN
  };
  var bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  var err = function (e) { return e.name + ": " + String(e.message).slice(0, 140); };

  try { new WebAssembly.Module(bytes); res.wasmSync = "ok"; } catch (e) { res.wasmSync = err(e); }
  try { new Function("return 1"); res.newFunction = "ok"; } catch (e) { res.newFunction = err(e); }
  try { res.evalResult = String(eval("1+1")); } catch (e) { res.evalResult = err(e); }

  var jobs = [];
  jobs.push(WebAssembly.compile(bytes).then(
    function () { res.wasmAsync = "ok"; }, function (e) { res.wasmAsync = err(e); }));
  jobs.push((CDN ? fetch(CDN + "/tiny.wasm") : Promise.reject(new Error("no cdn"))).then(
    function (r) { res.fetchCdnWasm = "status " + r.status; }, function (e) { res.fetchCdnWasm = err(e); }));
  jobs.push((CDN ? WebAssembly.compileStreaming(fetch(CDN + "/tiny.wasm")) : Promise.reject(new Error("no cdn"))).then(
    function () { res.compileStreamingCdn = "ok"; }, function (e) { res.compileStreamingCdn = err(e); }));
  jobs.push(new Promise(function (resolve) {
    try {
      var u = URL.createObjectURL(new Blob(["self.postMessage(1);self.close();"], { type: "text/javascript" }));
      var w = new Worker(u);
      w.onerror = function (e) { res.nestedBlobWorker = "error: " + String(e.message || e.type); resolve(); };
      w.onmessage = function () { res.nestedBlobWorker = "ok"; try { w.terminate(); } catch (x) {} resolve(); };
      setTimeout(function () { if (!res.nestedBlobWorker) { res.nestedBlobWorker = "timeout"; } resolve(); }, 900);
    } catch (e) { res.nestedBlobWorker = err(e); resolve(); }
  }));

  Promise.all(jobs).then(function () { self.postMessage(res); },
    function (e) { res.jobsFailed = err(e); self.postMessage(res); });
})();
