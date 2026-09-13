import Guard.Core.Tree
import Guard.Policy.Tables.Html
import Guard.Policy.Tables.Svg
import Guard.Core.Limits

/-!
Profiles as data, and the decidable "restricts" relation on validator
descriptors and profiles.

A `Profile` is the mutable part of the policy: which elements and attributes
are permitted, which validator each attribute uses, which control attributes
are forced, which SVG contexts are text-only, and the structural limits.
`defaultProfile` is the one shipped profile, built from the tables generated
from `rules/policy.json`. Arbitrary runtime profile loading is deliberately
not part of this release: acceptance always runs against `defaultProfile`.

`Val.restricts` is decidable by inspection. Enumerations restrict by set
inclusion, integer ranges by interval inclusion, number lists by a smaller
bound, and every other (custom) grammar requires exact identity. There is no
implication solver, no regular expression and no callback, so a profile can
never exchange one grammar for another.
-/

namespace Guard

open V

/-- Strip rule tags. A tag changes the rule id cited on failure, not the
grammar, so restriction and semantics both ignore it. -/
def Val.core : Val → Val
  | .tagged _ v => v.core
  | v => v

/--
`sub.restricts sup` holds when every value `sub` accepts canonically is also
accepted canonically by `sup` -- see `Guard.Props.restricts_apply`, which
proves that implication rather than assuming it.
-/
def Val.restricts (sub sup : Val) : Bool :=
  match sub.core, sup.core with
  | .oneOf ws, .oneOf vs => !ws.isEmpty && ws.all (fun w => vs.contains w)
  -- A single fixed value is the smallest enumeration. The value must already
  -- be trimmed, because the enumeration validator returns the trimmed value.
  | .fixed w, .oneOf vs => vs.contains w && V.trim w == w
  | .fixed w, .fixed v => w == v
  | .int a b, .int lo hi => lo ≤ a && a ≤ b && b ≤ hi
  | .numList k, .numList m => 0 < k && k ≤ m
  | a, b => a == b

structure Profile where
  htmlGlobal : Table
  svgGlobal : Table
  htmlElements : List (String × Table)
  svgElements : List (String × Table)
  /-- Control attributes the checker always emits with these exact values. -/
  htmlForced : List (String × List (String × String))
  /-- SVG elements whose children must be text only. -/
  svgTextOnly : List String
  /-- HTML elements that are removed while their children are kept. Unwrapping
  is not permission: the element itself never reaches the output. -/
  htmlUnwrap : List String
  limits : Limits

/-- The shipped profile. -/
def defaultProfile : Profile :=
  { htmlGlobal := Guard.htmlGlobal
  , svgGlobal := Guard.svgGlobal
  , htmlElements := Guard.htmlElements
  , svgElements := Guard.svgElements
  , htmlForced := Guard.htmlForced
  , svgTextOnly := Guard.svgTextOnly
  , htmlUnwrap := Guard.htmlUnwrap.map (fun p => p.1)
  , limits := Guard.limits }

def Profile.globalTable (p : Profile) (ns : Ns) : Table :=
  if ns == .html then p.htmlGlobal else p.svgGlobal

def Profile.elements (p : Profile) (ns : Ns) : List (String × Table) :=
  if ns == .html then p.htmlElements else p.svgElements

def Profile.elementTable (p : Profile) (ns : Ns) (tag : String) : Option Table :=
  (p.elements ns).lookup tag

/-- The validator a profile uses for `name` on an element with table `table`:
the element's own entry, otherwise the namespace's global entry. -/
def Profile.attrFor (p : Profile) (ns : Ns) (table : Table) (name : String) : Option Val :=
  (table.lookup name).orElse (fun _ => (p.globalTable ns).lookup name)

def Limits.within (l c : Limits) : Bool :=
  l.maxNodes ≤ c.maxNodes && l.maxDepth ≤ c.maxDepth &&
  l.maxTextLength ≤ c.maxTextLength && l.maxTotalText ≤ c.maxTotalText &&
  l.maxAttrs ≤ c.maxAttrs && l.maxAttrValueLength ≤ c.maxAttrValueLength &&
  l.maxPathNumbers ≤ c.maxPathNumbers && l.maxPointsNumbers ≤ c.maxPointsNumbers &&
  l.maxNumberMagnitude ≤ c.maxNumberMagnitude && l.maxTraversalDepth ≤ c.maxTraversalDepth

/--
`profileRestricts p2 p1`: `p2` permits no more than `p1` does. Every element
`p2` permits is permitted by `p1` with a wider-or-equal grammar for every name
either profile could resolve there; `p2` forces at least the control
attributes `p1` forces; `p2`'s text-only contexts cover `p1`'s; and `p2`'s
limits are no larger.

`Guard.Props.restricts_permits` proves the consequence for permitted *output
trees*. It does not say that a tighter profile accepts fewer raw inputs: a
tighter profile can remove more content and still accept a smaller output.
-/
def tableRestricts (p2 p1 : Profile) (ns : Ns) (t2 t1 : Table) : Bool :=
  (t2 ++ p2.globalTable ns).all fun entry =>
    match p2.attrFor ns t2 entry.1, p1.attrFor ns t1 entry.1 with
    | some v, some w => v.restricts w
    | _, _ => false

def elementsRestrict (p2 p1 : Profile) (ns : Ns) : Bool :=
  (p2.elements ns).all fun entry =>
    match p1.elementTable ns entry.1 with
    | none => false
    | some t1 => tableRestricts p2 p1 ns entry.2 t1

def forcedRestricts (p2 p1 : Profile) : Bool :=
  p1.htmlForced.all fun entry =>
    match p2.elementTable .html entry.1 with
    | none => true
    | some _ => entry.2.all fun pair => (((p2.htmlForced.lookup entry.1).getD []).lookup pair.1) == some pair.2

def textOnlyRestricts (p2 p1 : Profile) : Bool :=
  p1.svgTextOnly.all fun tag => (p2.elementTable .svg tag).isNone || p2.svgTextOnly.contains tag

/-- Both namespaces, so that namespace-generic lemmas need no case split. -/
def allNs : List Ns := [.html, .svg]

def profileRestricts (p2 p1 : Profile) : Bool :=
  allNs.all (elementsRestrict p2 p1) &&
  forcedRestricts p2 p1 && textOnlyRestricts p2 p1 && p2.limits.within p1.limits

end Guard
