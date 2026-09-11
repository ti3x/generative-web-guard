import Guard.Core.Tree
import Guard.Policy.Check

/-!
Request/response API shared by the native executable (`Main.lean`, stdin to
stdout) and the WebAssembly export (`guard_check`, string to string).

Request:  { "classes": ["card", ...], "inputs": [ { "kind": "root", "children": [...] }, ... ] }
Response: [ { "status": "validated", "tree": {...}, "changes": n, "changeKinds": [...] }
          | { "status": "rejected", "reasons": [...] }, ... ]
-/

namespace Guard

open J

def resultToJson : Result → Json
  | .validated tree changes =>
    .obj
      [ ("status", .str "validated")
      , ("tree", .obj [("kind", .str "root"), ("children", .arr (tree.map Node.toJson))])
      , ("changes", .num (toString changes.length))
      , ("changeKinds", .arr (changes.map fun c => .str c.kind))
      , ("changeRules", .arr (changes.map fun c => .str c.rule)) ]
  | .rejected reasons =>
    .obj [("status", .str "rejected"), ("reasons", .arr (reasons.map Json.str))]

/-- Pure request handler. Invalid JSON yields an error object rather than a crash. -/
def processRequest (input : String) : String :=
  match J.parse input with
  | .error e => (Json.obj [("error", .str s!"invalid JSON: {e}")]).compress
  | .ok j =>
    let classes : List String := (j.getArr "classes").filterMap Json.asStr?
    let ctx : Ctx := { classes }
    let results := (j.getArr "inputs").map fun raw => resultToJson (checkTree ctx (rawRootChildren raw))
    (Json.arr results).compress

/-- C symbol for the WebAssembly build. See `lean/wasm/shim.c`. -/
@[export guard_check]
def guardCheck (input : String) : String := processRequest input

end Guard
