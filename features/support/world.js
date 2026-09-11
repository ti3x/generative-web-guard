// Cucumber World: per-scenario state plus the engine runner shared by all steps.
import { setWorldConstructor, World } from "@cucumber/cucumber";
import { DEFAULT_CLASSES } from "../../scripts/lib/engines.mjs";
import { checkTree, setClassAllowlist } from "../../src/policy.js";
import { summarizeJs } from "../../scripts/lib/engines.mjs";

export let loadedEngines = [];
export function setLoadedEngines(list) { loadedEngines = list; }

class GuardWorld extends World {
  constructor(options) {
    super(options);
    this.classes = [...DEFAULT_CLASSES];
    this.html = null;
    this.raw = null;
    this.results = new Map(); // engine name -> summary
    this.js = null;           // JS summary (reference)
    this.jsChanges = [];      // full JS change records for traceability steps
  }

  get engines() { return loadedEngines; }

  async validate(engineNames) {
    if (!this.raw) throw new Error("no HTML given; add a Given step");
    this.results = new Map();
    for (const engine of loadedEngines) {
      if (!engineNames.includes(engine.name)) continue;
      const [summary] = await engine.run([this.raw], this.classes);
      this.results.set(engine.name, summary);
    }
    // Keep the raw JS change records for "a change cites rule" diagnostics.
    setClassAllowlist(this.classes);
    const full = checkTree(this.raw);
    this.jsChanges = full.status === "validated" ? full.changes : [];
    this.js = this.results.get("js") ?? summarizeJs(full);
    if (!this.results.has("js")) this.results.set("js", this.js);
  }
}

setWorldConstructor(GuardWorld);
