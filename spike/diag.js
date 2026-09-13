import { CDN } from "/probe-src.js";
const R = { violations: [] };
document.addEventListener("securitypolicyviolation", (e) =>
  R.violations.push({ d: e.effectiveDirective || e.violatedDirective, b: String(e.blockedURI).slice(0, 80) }));
const blobUrl = (s) => URL.createObjectURL(new Blob([s], { type: "text/javascript" }));
function probe(src) {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(blobUrl(src), { type: "module", name: CDN }); }
    catch (e) { return resolve(`throw ${e.name}: ${e.message.slice(0, 120)}`); }
    const t = setTimeout(() => { try { w.terminate(); } catch (x) {} resolve("timeout"); }, 2500);
    w.onerror = (e) => { clearTimeout(t); resolve(`error-event: ${String(e.message || e.type)}`); };
    w.onmessage = (e) => { clearTimeout(t); try { w.terminate(); } catch (x) {} resolve(`ok: ${e.data && e.data.type}`); };
  });
}
R.static = await probe(`import ${JSON.stringify(CDN + "/worker-probe.js")};`);
R.dynamic = await probe(`await import(${JSON.stringify(CDN + "/worker-probe.js")});`);
document.getElementById("out").textContent = JSON.stringify(R, null, 1);
window.__result = R;
window.__done = true;
