import Guard.Core.Tree
import Guard.Policy.Tables.Html
import Guard.Policy.Tables.Svg

/-!
Acceptance predicate over output trees. This does not sanitize or repair.
It independently checks the normalizer's candidate before it can be accepted.
The theorem in Props.Checker covers this explicit predicate, not the browser.
-/
namespace Guard
open V

def elementTable (ns : Ns) (tag : String) : Option Table :=
  (if ns == .html then htmlElements else svgElements).lookup tag

def attrCanonical (ctx : Ctx) (ns : Ns) (table : Table) (pair : String × String) : Bool :=
  let (name, value) := pair
  let global := if ns == .html then htmlGlobal else svgGlobal
  !(name.contains ':' || name.startsWith "on") &&
    match (table.lookup name).orElse (fun _ => global.lookup name) with
    | none => false
    | some validator => validator.apply ctx value == some value

def attrsCanonical (ctx : Ctx) (ns : Ns) (tag : String) (table : Table)
    (attrs : List (String × String)) : Bool :=
  attrs.length ≤ limits.maxAttrs && attrs.all (attrCanonical ctx ns table) &&
  (if ns == .html then
    ((htmlForced.lookup tag).getD []).all (fun (n, v) => attrs.lookup n == some v) &&
    (tag != "input" || (attrs.lookup "type").isSome)
  else true)

mutual
def nodePolicyOk (ctx : Ctx) (parent : Ns) (depth : Nat) (textOnly : Bool) : Node → Bool
  | .text s => !s.isEmpty && cleanText s == s && utf16Length s ≤ limits.maxTextLength
  | .el ns tag attrs children =>
    !textOnly && depth + 1 ≤ limits.maxDepth &&
    (if ns == .html then parent == .html else tag == "svg" || parent == .svg) &&
    match elementTable ns tag with
    | none => false
    | some table => attrsCanonical ctx ns tag table attrs &&
      nodesPolicyOk ctx ns (depth + 1) (ns == .svg && svgTextOnly.contains tag) children

def nodesPolicyOk (ctx : Ctx) (parent : Ns) (depth : Nat) (textOnly : Bool) : List Node → Bool
  | [] => true
  | n :: ns => nodePolicyOk ctx parent depth textOnly n && nodesPolicyOk ctx parent depth textOnly ns
end

mutual
def nodeStats : Node → Nat × Nat
  | .text s => (1, utf16Length s)
  | .el _ _ _ children => let (n, t) := treeStats children; (n + 1, t)

def treeStats : List Node → Nat × Nat
  | [] => (0, 0)
  | n :: ns => let a := nodeStats n; let b := treeStats ns; (a.1 + b.1, a.2 + b.2)
end

def policyOk (ctx : Ctx) (tree : List Node) : Bool :=
  nodesPolicyOk ctx .html 0 false tree &&
  (treeStats tree).1 ≤ limits.maxNodes && (treeStats tree).2 ≤ limits.maxTotalText

end Guard
