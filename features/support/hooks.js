// Loads the engines once per run and resets module-global policy state per scenario.
import { BeforeAll, Before, setDefaultTimeout } from "@cucumber/cucumber";
import { loadEngines, DEFAULT_CLASSES } from "../../scripts/lib/engines.mjs";
import { setClassAllowlist } from "../../src/policy.js";
import { setLoadedEngines } from "./world.js";

// Docker round trips for the Lean engine take a few hundred milliseconds each.
setDefaultTimeout(30_000);

BeforeAll(async function () {
  const engines = await loadEngines({ engines: process.env.ENGINES ?? "js" });
  setLoadedEngines(engines);
  console.log(`engines: ${engines.map((e) => e.name).join(", ")}`);
});

Before(function () {
  setClassAllowlist(DEFAULT_CLASSES);
});
