// Single-file CDN entry point. The QuickJS worker is embedded as source so a
// page can create it from a same-origin blob even when this module came from a
// different CDN origin.

import workerSource from "guard:worker-source";
import { createRuntimeController } from "./runtime/controller.js";

export * from "./cdn.js";

export function createGuardWorker(options = {}) {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    throw new Error("createGuardWorker: Web Workers and Blob URLs are required");
  }
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    const worker = new Worker(url, options);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return worker;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function createGuardRuntime(options = {}) {
  const { worker: workerOptions, ...controllerOptions } = options;
  return createRuntimeController({
    ...controllerOptions,
    createWorker: () => createGuardWorker(workerOptions),
  });
}
