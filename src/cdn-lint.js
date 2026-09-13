// Opt-in development entry point for the optional program linter.
//
// Separate from the default entry point on purpose: its result is diagnostic
// eligibility, never authorization, and it is the only reason Acorn would be
// in a bundle. Do not use it as a security control - QuickJS confinement is
// the boundary and is tested with this linter bypassed.

export { gateProgram, LINT_BUDGETS } from "./gate.js";
