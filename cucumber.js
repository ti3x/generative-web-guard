// Cucumber.js configuration (ESM). ENGINES=js,lean,wasm selects the engines to run
// (each must be available or the run fails); default is the JavaScript checker.
export default {
  paths: ["features/**/*.feature"],
  import: ["features/support/**/*.js", "features/steps/**/*.js"],
  format: ["progress", "summary"],
};
