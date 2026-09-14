import Guard.Core.Tree
import Guard.Policy.Check
import Guard.Policy.Candidate

/-!
Reference request/response API for the native executable (`Main.lean`, stdin
to stdout). Never imported by the production Wasm root. Each accepted result
also asserts candidate compatibility in the differential harness.

Request:  { "classes": ["card", ...], "inputs": [ { "kind": "root", "children": [...] }, ... ] }
Response: [ { "status": "validated", "tree": {...}, "changes": n, "changeKinds": [...] }
          | { "status": "rejected", "reasons": [...] }, ... ]
-/

namespace Guard

open J

def resultToJson (ctx : Ctx) : Result → Json
  | .validated tree changes =>
    .obj
      [ ("status", .str "validated")
      , ("candidateAccepted", .bool (acceptCandidate defaultProfile ctx tree))
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
    let results := (j.getArr "inputs").map fun raw => resultToJson ctx (checkTree ctx (rawRootChildren raw))
    (Json.arr results).compress

/-!
There is deliberately NO `@[export]` here any more.

This batch interface is permissive by design: it takes a caller-supplied class
list, a list of documents, and decodes each with the lenient
`Guard.rawFromJson`. That shape is right for a differential-testing tool and
wrong for an authority, so the WebAssembly module exports only the versioned
single-document ABI in `Guard/Io/Abi.lean`. `Main.lean` calls
`processRequest` directly, so the native executable used by
`scripts/lean-differential.mjs` is unaffected.
-/

end Guard
