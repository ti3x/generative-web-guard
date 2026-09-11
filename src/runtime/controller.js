// Host-side runtime controller. Owns the program state as JSON text, drives
// the QuickJS worker one request at a time, enforces a watchdog, and tags
// everything with a generation number so stale results are dropped.
//
// On any failure the runtime is marked dead: interaction stops, the caller
// keeps its last validated view, and the trusted UI shows the failure. There
// is deliberately no fallback to running generated code anywhere else.

// watchdogMs bounds a single step round trip. loadWatchdogMs bounds worker
// startup plus Wasm instantiation plus program load and init, which on first
// use in a cold browser can take several seconds.
export function createRuntimeController({ createWorker, watchdogMs = 1500, loadWatchdogMs = 15000, maxQueue = 32, onDead }) {
  let worker = null;
  let nextId = 1;
  let generation = 0;
  let stateJson = null;
  let dead = false;
  let inFlight = null; // { id, resolve, reject, timer }
  const queue = []; // pending step requests
  let dropped = 0;

  function markDead(reason) {
    if (dead) return;
    dead = true;
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight.reject(new Error(reason));
      inFlight = null;
    }
    while (queue.length) queue.shift().reject(new Error(reason));
    if (worker) {
      worker.terminate();
      worker = null;
    }
    onDead && onDead(reason);
  }

  function request(type, payload) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(new Error("runtime is dead"));
      const id = nextId++;
      const budget = type === "step" ? watchdogMs : loadWatchdogMs;
      const timer = setTimeout(() => markDead(`watchdog: ${type} exceeded ${budget}ms`), budget);
      inFlight = { id, resolve, reject, timer };
      worker.postMessage({ id, type, ...payload });
    });
  }

  function onMessage(e) {
    const msg = e.data;
    if (!inFlight || !msg || msg.id !== inFlight.id) return; // stale or unknown
    clearTimeout(inFlight.timer);
    const { resolve, reject } = inFlight;
    inFlight = null;
    if (msg.ok) resolve(msg.result);
    else reject(new Error(String(msg.error)));
  }

  // One step at a time. The next job starts only after this one's state has
  // been committed, so every step sees the state produced by the previous one.
  function pump() {
    if (dead || inFlight || queue.length === 0) return;
    const job = queue.shift();
    const gen = generation;
    request("step", { state: stateJson, event: JSON.stringify(job.event) })
      .then((result) => {
        if (gen !== generation) return job.reject(new Error("stale generation"));
        if (typeof result.state !== "string" || typeof result.view !== "string") {
          return markDead("malformed worker result");
        }
        stateJson = result.state;
        job.resolve({ view: result.view, generation: gen });
      })
      .catch((err) => {
        markDead(err.message);
        job.reject(err);
      })
      .finally(pump);
  }

  return {
    // data: optional host-owned dataset (any JSON-serializable value). It is
    // serialized here, so nothing but JSON text reaches the worker, and the
    // program sees it as a frozen global named data.
    async load(source, data = undefined) {
      if (worker) throw new Error("already loaded");
      worker = createWorker();
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", () => markDead("worker error"));
      generation++;
      try {
        const dataJson = data === undefined ? null : JSON.stringify(data);
        if (data !== undefined && typeof dataJson !== "string") throw new Error("data is not JSON-serializable");
        await request("load", { source, data: dataJson });
        const result = await request("init", {});
        if (typeof result.state !== "string" || typeof result.view !== "string") throw new Error("malformed init");
        stateJson = result.state;
        return { view: result.view, generation };
      } catch (err) {
        markDead(err.message);
        throw err;
      }
    },
    // Queue a plain-data event. Resolves with the next view string.
    step(event) {
      return new Promise((resolve, reject) => {
        if (dead) return reject(new Error("runtime is dead"));
        if (queue.length >= maxQueue) {
          dropped++;
          return reject(new Error("event queue full"));
        }
        queue.push({ event, resolve, reject });
        pump();
      });
    },
    dispose() {
      markDead("disposed");
    },
    get dead() { return dead; },
    get generation() { return generation; },
    get droppedEvents() { return dropped; },
  };
}
