import Guard.Core.Tree
import Guard.Policy.Tables.Html
import Guard.Policy.Tables.Svg
import Guard.Policy.Tables.Attrs
import Guard.Policy.Accept

/-!
The reconstruct-from-allowlist checker. This is the executable specification
that `checkTree` in `src/policy.js` must agree with; the differential test
feeds both the same parser output and compares the trees and the change
records.
-/

namespace Guard

open V

structure Change where
  kind : String
  tag : String := ""
  name : String := ""
  path : List Nat := []
  why : String := ""
  /-- Rule id from rules/catalog.json that this change cites. -/
  rule : String := ""
deriving Repr, BEq, DecidableEq

structure St where
  nodes : Nat := 0
  totalText : Nat := 0
  changes : List Change := []
  reasons : List String := []

abbrev M := StateM St

def change (c : Change) : M Unit := modify fun s => { s with changes := c :: s.changes }
def reject (code : String) : M Unit := modify fun s => { s with reasons := code :: s.reasons }
def rejected : M Bool := do return !(← get).reasons.isEmpty

def sortAttrs (attrs : List (String × String)) : List (String × String) :=
  attrs.mergeSort (fun a b => a.1 ≤ b.1)

def checkAttrStep (ctx : Ctx) (ns : Ns) (tag : String) (table : Table) (path : List Nat)
    (pair : String × String) (acc : Nat × List (String × String)) :
    M (ForInStep (Nat × List (String × String))) := do
  let global := if ns == .html then htmlGlobal else svgGlobal
  let (rawName, value) := pair
  let (count, seen) := acc
  let lower := asciiLower rawName
  let name := if ns == .svg then (svgCanonical.lookup lower).getD lower else lower
  let count := count + 1
  if count > limits.maxAttrs then
    change { kind := "removed-attribute", tag, name, path, why := "too-many", rule := R.LIMIT_ATTRS }
    return .yield (count, seen)
  if name.contains ':' || name.startsWith "on" then
    change { kind := "removed-attribute", tag, name, path, rule := dropRuleFor name }
    return .yield (count, seen)
  match (table.lookup name).orElse (fun _ => global.lookup name) with
  | none =>
    change { kind := "removed-attribute", tag, name, path, rule := dropRuleFor name }
    return .yield (count, seen)
  | some v =>
    if utf16Length value > limits.maxAttrValueLength * 10 then
      change { kind := "removed-attribute", tag, name, path, why := "too-long", rule := R.LIMIT_ATTRS }
      return .yield (count, seen)
    match v.apply ctx value with
    | none =>
      change { kind := "removed-attribute", tag, name, path, why := "value", rule := v.rule }
      return .yield (count, seen)
    | some canonical =>
      if canonical != value then change { kind := "rewrote-attribute", tag, name, path, rule := v.rule }
      return .yield (count, if (seen.lookup name).isNone then seen ++ [(name, canonical)] else seen)

def forceAttrStep (pair : String × String) (seen : List (String × String)) :
    M (ForInStep (List (String × String))) :=
  pure (.yield (if (seen.lookup pair.1).isNone then seen ++ [pair] else seen))

def checkAttrs (ctx : Ctx) (ns : Ns) (tag : String) (table : Table) (path : List Nat)
    (raw : List (String × String)) : M (List (String × String)) := do
  let (_, seen) ← forIn raw (0, []) (checkAttrStep ctx ns tag table path)
  let mut seen := seen
  if ns == .html then
    seen ← forIn ((htmlForced.lookup tag).getD []) seen forceAttrStep
    if tag == "input" && (seen.lookup "type").isNone then seen := seen ++ [("type", "text")]
  return sortAttrs seen

mutual
def checkChildren (fuel : Nat) (ctx : Ctx) (raws : List Raw) (parentNs : Ns) (depth : Nat)
    (sdepth : Nat) (path : List Nat) (textOnly : Bool) : M (List Node) :=
  match fuel with
  | 0 => do reject "traversal-budget"; return []
  | fuel + 1 => do
    -- Structural traversal ceiling. Unlike `maxDepth` this counts every
    -- descent, including chains of unwrapped elements that do not increase
    -- output depth. `src/policy.js` applies the identical ceiling at the
    -- identical point so the two checkers still agree.
    if sdepth > limits.maxTraversalDepth then
      reject "traversal-depth"
      return []
    let (_, out) ← forIn raws (0, []) (checkChildStep fuel ctx parentNs depth sdepth path textOnly)
    return out
termination_by 3 * fuel + 1

def checkChildStep (fuel : Nat) (ctx : Ctx) (parentNs : Ns) (depth sdepth : Nat)
    (path : List Nat) (textOnly : Bool) (raw : Raw) (acc : Nat × List Node) :
    M (ForInStep (Nat × List Node)) := do
  let mut index := acc.1
  let mut out := acc.2
  let here := path ++ [index]
  index := index + 1
  if ← rejected then return .yield (index, out)
  match raw with
  | .text s =>
    let s := cleanText s
    let len := utf16Length s
    if len == 0 then return .yield (index, out)
    if len > limits.maxTextLength then reject "text-too-long"; return .yield (index, out)
    modify fun st => { st with totalText := st.totalText + len }
    if (← get).totalText > limits.maxTotalText then reject "total-text-too-long"; return .yield (index, out)
    modify fun st => { st with nodes := st.nodes + 1 }
    if (← get).nodes > limits.maxNodes then reject "too-many-nodes"; return .yield (index, out)
    out := out ++ [.text s]
  | .other k =>
    change { kind := "removed-node", name := k, path := here, rule := R.STRUCT_NON_ELEMENT }
  | .el nsStr rawTag attrs children =>
    if textOnly then
      change { kind := "removed-element", tag := rawTag, path := here, why := "text-only-context", rule := R.NS_POSITION }
      return .yield (index, out)
    let tag := asciiLower rawTag
    if depth + 1 > limits.maxDepth then reject "too-deep"; return .yield (index, out)
    let ns? : Option Ns := if nsStr == "svg" then some .svg else if nsStr == "html" then some .html else none
    match ns? with
    | some .html =>
      if parentNs != .html then
        change { kind := "removed-element", tag, path := here, why := "namespace", rule := R.NS_POSITION }
      else
        match htmlElements.lookup tag with
        | some table => out := out ++ [← checkElement fuel ctx .html tag table attrs children depth (sdepth + 1) here]
        | none =>
          match htmlUnwrap.lookup tag with
          | some rule =>
            change { kind := "unwrapped-element", tag, path := here, rule }
            out := out ++ (← checkChildren fuel ctx children parentNs depth (sdepth + 1) here false)
          | none =>
            change { kind := "removed-element", tag, path := here, rule := (htmlDropRules.lookup tag).getD R.STRUCT_ELEMENT_ALLOWLIST }
    | some .svg =>
      if !(tag == "svg" || parentNs == .svg) then
        change { kind := "removed-element", tag, path := here, why := "namespace", rule := R.NS_POSITION }
      else
        match svgElements.lookup tag with
        | some table => out := out ++ [← checkElement fuel ctx .svg tag table attrs children depth (sdepth + 1) here]
        | none => change { kind := "removed-element", tag, path := here, rule := (svgDropRules.lookup tag).getD R.STRUCT_ELEMENT_ALLOWLIST }
    | none =>
      change { kind := "removed-element", tag, path := here, why := "namespace", rule := R.NS_MATHML }
  return .yield (index, out)
termination_by 3 * fuel + 3

def checkElement (fuel : Nat) (ctx : Ctx) (ns : Ns) (tag : String) (table : Table) (attrs : List (String × String))
    (children : List Raw) (depth : Nat) (sdepth : Nat) (here : List Nat) : M Node :=
  match fuel with
  | 0 => do reject "traversal-budget"; return .text ""
  | fuel + 1 => do
    modify fun st => { st with nodes := st.nodes + 1 }
    if (← get).nodes > limits.maxNodes then
      reject "too-many-nodes"
      return .text ""
    let outAttrs ← checkAttrs ctx ns tag table here attrs
    let childTextOnly := ns == .svg && svgTextOnly.contains tag
    let kids ← checkChildren fuel ctx children ns (depth + 1) sdepth here childTextOnly
    return .el ns tag outAttrs kids
termination_by 3 * fuel + 2
end

inductive Result where
  | validated (tree : List Node) (changes : List Change)
  | rejected (reasons : List String)
deriving Repr, BEq, DecidableEq

def normalizeTree (ctx : Ctx) (rootChildren : List Raw) : Result :=
  let (tree, st) := (checkChildren (2 * rawWeight rootChildren + 1) ctx rootChildren .html 0 0 [] false).run {}
  if st.reasons.isEmpty then .validated tree st.changes.reverse else .rejected st.reasons.reverse

/-- Only candidates that obey the output policy and normalize unchanged are
accepted. A failed postcondition rejects, never releases an unchecked tree. -/
def checkTree (ctx : Ctx) (raws : List Raw) : Result :=
  -- R.CHECK_ACCEPTANCE: both postconditions must hold before release.
  match normalizeTree ctx raws with
  | .rejected reasons => .rejected reasons
  | .validated tree changes =>
    if policyOk ctx tree then
      if normalizeTree ctx (nodesToRaw tree) = .validated tree [] then
        .validated tree changes
      else .rejected ["non-canonical-output"]
    else .rejected ["output-policy"]

end Guard
