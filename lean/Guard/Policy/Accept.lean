import Guard.Core.Tree
import Guard.Policy.Profile

/-!
Acceptance predicate over output trees. This does not sanitize or repair.
It independently checks the normalizer's candidate before it can be accepted.
The theorem in Props.Checker covers this explicit predicate, not the browser.

The predicate is parameterized by a `Profile` so that profile well-formedness
and the profile-restriction property can be stated about it (see
`Guard.Policy.Cap` and `Guard.Props.Profile`). Production acceptance always
uses `defaultProfile`; `policyOk` is that instance, and nothing loads a
profile at runtime.
-/
namespace Guard
open V

def attrCanonical (prof : Profile) (ctx : Ctx) (ns : Ns) (table : Table) (pair : String × String) : Bool :=
  let (name, value) := pair
  !(name.contains ':' || name.startsWith "on") &&
    match prof.attrFor ns table name with
    | none => false
    | some validator => validator.apply ctx value == some value

def attrsCanonical (prof : Profile) (ctx : Ctx) (ns : Ns) (tag : String) (table : Table)
    (attrs : List (String × String)) : Bool :=
  attrs.length ≤ prof.limits.maxAttrs && attrs.all (attrCanonical prof ctx ns table) &&
  (if ns == .html then
    ((prof.htmlForced.lookup tag).getD []).all (fun (n, v) => attrs.lookup n == some v) &&
    (tag != "input" || (attrs.lookup "type").isSome)
  else true)

mutual
def nodePolicyOk (prof : Profile) (ctx : Ctx) (parent : Ns) (depth : Nat) (textOnly : Bool) : Node → Bool
  | .text s => !s.isEmpty && cleanText s == s && utf16Length s ≤ prof.limits.maxTextLength
  | .el ns tag attrs children =>
    !textOnly && depth + 1 ≤ prof.limits.maxDepth &&
    (if ns == .html then parent == .html else tag == "svg" || parent == .svg) &&
    match prof.elementTable ns tag with
    | none => false
    | some table => attrsCanonical prof ctx ns tag table attrs &&
      nodesPolicyOk prof ctx ns (depth + 1) (ns == .svg && prof.svgTextOnly.contains tag) children

def nodesPolicyOk (prof : Profile) (ctx : Ctx) (parent : Ns) (depth : Nat) (textOnly : Bool) : List Node → Bool
  | [] => true
  | n :: ns => nodePolicyOk prof ctx parent depth textOnly n && nodesPolicyOk prof ctx parent depth textOnly ns
end

mutual
def nodeStats : Node → Nat × Nat
  | .text s => (1, utf16Length s)
  | .el _ _ _ children => let (n, t) := treeStats children; (n + 1, t)

def treeStats : List Node → Nat × Nat
  | [] => (0, 0)
  | n :: ns => let a := nodeStats n; let b := treeStats ns; (a.1 + b.1, a.2 + b.2)
end

/-- Trees a profile permits as output. -/
def Profile.permits (prof : Profile) (ctx : Ctx) (tree : List Node) : Bool :=
  nodesPolicyOk prof ctx .html 0 false tree &&
  (treeStats tree).1 ≤ prof.limits.maxNodes && (treeStats tree).2 ≤ prof.limits.maxTotalText

/-- Production acceptance: the shipped profile. -/
def policyOk (ctx : Ctx) (tree : List Node) : Bool :=
  defaultProfile.permits ctx tree

end Guard
