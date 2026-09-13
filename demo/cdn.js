// Cross-origin CDN check page.
//
// This is the end-to-end evidence for Profile A. Nothing in this file is part
// of the library: it is a host page that
//
//   1. dynamically imports the shipped bundle from a DIFFERENT origin
//      (await import(), which CSP checks against script-src -- a static
//      top-level import inside a Worker would be checked against worker-src
//      instead and would fail with no violation report at all),
//   2. lets that cross-origin module create the policy Worker and the QuickJS
//      Worker from blob: URLs carrying its own embedded payloads,
//   3. lets it create the sandboxed opaque-origin frame, and
//   4. drives one acknowledged render plus one interactive program.
//
// Each step is recorded as a named stage so a failure says which stage and
// which directive, rather than "it did not load".
//
// The CDN origin comes from ?cdn=<origin>; scripts/serve.mjs prints it on
// startup. No inline script is used, because the host policy has no
// 'unsafe-inline'.

const params = new URLSearchParams(location.search);
const cdnOrigin = params.get("cdn") || `http://127.0.0.1:${Number(location.port || 80) + 1}`;
const bundle = params.get("bundle") || "generative-web-guard.full.min.js";
const bundleUrl = `${cdnOrigin}/${bundle}`;

const $ = (id) => document.getElementById(id);
const stages = [];
let finished = false;

function stage(name, ok, detail = null) {
  stages.push({ name, ok, ...(detail ? { detail } : {}) });
  $("report").textContent = stages
    .map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.name}${s.detail ? ` ${JSON.stringify(s.detail)}` : ""}`)
    .join("\n");
}

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function describe(error) {
  // A StartupError carries a code, a stage and a hint naming the directive.
  if (error && error.code) {
    return { code: error.code, stage: error.stage ?? null, hint: String(error.hint ?? "").slice(0, 300) };
  }
  return { code: null, message: String((error && error.message) || error).slice(0, 300) };
}

const BENIGN_HTML = '<div class="card stack"><h2 class="title">Loaded from another origin</h2>'
  + '<p class="muted small">Validated by the cross-origin bundle, rendered in the opaque frame.</p></div>';

const PROGRAM = `const initialState = { count: 0 };
function update(state, event) {
  return event.action === "increment" ? { count: state.count + 1 } : state;
}
function view(state) {
  return '<div class="card stack"><h2 class="title">Cross-origin interactive</h2>'
    + '<div class="row"><button class="btn" data-action="increment">Clicked ' + state.count + '</button></div></div>';
}`;

async function main() {
  let mod;
  // ---- stage: cdn-import -------------------------------------------------
  try {
    mod = await import(bundleUrl);
    stage("cdn-import", true, { url: bundleUrl, crossOrigin: new URL(bundleUrl).origin !== location.origin });
  } catch (error) {
    // effectiveDirective script-src-elem when the host script-src omits the
    // library origin.
    stage("cdn-import", false, { url: bundleUrl, ...describe(error), likely: "csp-cdn-script-src" });
    setStatus("cross-origin import refused", true);
    finished = true;
    return;
  }

  // ---- stage: policy worker (worker-create + channel-handshake) ---------
  // The policy session comes FIRST now: the frame commits acceptance records
  // issued by this session, so `createGuardFrame` needs it. That ordering is
  // the point -- there is no way to obtain a frame that would render a tree
  // without an authority behind it.
  const policy = mod.createGuardPolicySession({
    onTerminated: ({ code, detail, stage: at }) => {
      if (code !== "disposed") stage(`policy-terminated:${code}`, false, { at: at ?? null, detail: detail ?? null });
    },
  });
  try {
    // start() creates the Worker and resolves when the Lean authority exists.
    const starting = policy.start();
    await policy.whenReady();
    stage("policy-worker-handshake", true);
    const checker = await starting;
    stage("lean-checker-ready", true, checker);
  } catch (error) {
    stage("lean-checker-ready", false, describe(error));
    setStatus("the Lean/Wasm checker did not start; nothing can be rendered", true);
    finished = true;
    return;
  }

  // ---- stage: frame-bootstrap -------------------------------------------
  let frame;
  try {
    frame = mod.createGuardFrame({
      container: $("frame-container"),
      policy,
      onStatus: ({ kind, detail }) => {
        if (kind === "startup-warning") stage(`frame-warning:${detail.code}`, true, detail);
      },
      onEvent: (event) => { void handleEvent(event); },
    });
    const info = await frame.ready;
    // Firefox 141 has no Trusted Types at all, so this records which of the
    // two rendering-boundary layers the engine actually provided.
    stage("frame-bootstrap", true, info);
  } catch (error) {
    stage("frame-bootstrap", false, describe(error));
    setStatus("frame did not bootstrap", true);
    finished = true;
    return;
  }

  // ---- stage: policy-accept ---------------------------------------------
  let accepted = null;
  const decision = await policy.preprocess(BENIGN_HTML);
  if (decision.status !== "accepted") {
    stage("policy-accept", false, { status: decision.status, reason: decision.reason ?? null });
    setStatus("policy worker rejected the benign document", true);
    finished = true;
    return;
  }
  accepted = decision.acceptance;
  stage("policy-accept", true, { authority: decision.authority, checkerVersion: decision.stats.checkerVersion });

  // ---- stage: commit ----------------------------------------------------
  // A bare tree is refused even though it is the very tree that was accepted:
  // the record is the authorization, not the tree. Measured here on the
  // shipped cross-origin bundle rather than asserted.
  stage("bare-tree-refused", (await frame.render(decision.tree)) === false);
  const rendered = await frame.render(accepted);
  stage("frame-commit", rendered === true);
  stage("replay-refused", (await frame.render(accepted)) === false);

  // ---- stage: wasm-init (QuickJS inside the blob: Worker) ---------------
  // The blob: Worker inherits this document's CSP, so this is where a missing
  // 'wasm-unsafe-eval' shows up -- as a CompileError relayed back over the
  // port, reported as csp-wasm-unsafe-eval.
  runtime = mod.createGuardRuntime({
    onDead: (reason) => { if (reason !== "disposed") stage("runtime-dead", false, { reason: String(reason).slice(0, 300) }); },
  });
  try {
    const { view } = await runtime.load(PROGRAM);
    stage("wasm-init", true);
    const viewDecision = await policy.preprocess(view);
    if (viewDecision.status !== "accepted") {
      stage("view-accept", false, { status: viewDecision.status, reason: viewDecision.reason ?? null });
      finished = true;
      return;
    }
    stage("view-accept", true);
    stage("view-commit", (await frame.render(viewDecision.acceptance)) === true);
    policySession = policy;
    frameRef = frame;
    setStatus("cross-origin bundle: interactive", false);
  } catch (error) {
    stage("wasm-init", false, describe(error));
    setStatus("QuickJS worker did not start", true);
  }
  finished = true;
}

let runtime = null;
let policySession = null;
let frameRef = null;

async function handleEvent(event) {
  if (!runtime || runtime.dead || !policySession || !frameRef) return;
  const { view } = await runtime.step(event);
  const decision = await policySession.preprocess(view);
  if (decision.status === "accepted") await frameRef.render(decision.acceptance);
}

window.__guardCdnProbe = {
  stages: () => stages.slice(),
  done: () => finished,
  bundleUrl,
};

main().catch((error) => {
  stage("unexpected", false, describe(error));
  setStatus("unexpected failure", true);
  finished = true;
});
