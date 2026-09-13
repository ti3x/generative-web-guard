import Guard.Policy.Profile

/-!
The reviewed capability kernel, and profile well-formedness against it.

`Capabilities` is the closed inventory: element and attribute identities, the
widest value grammar reviewed for each attribute in its context, mandatory
control attributes, the text-only SVG contexts, the reviewed unwrappable
elements, absolute resource ceilings, and explicit exclusions. The data lives
in `rules/capabilities.json` and is generated into
`Guard/Policy/Capabilities.lean`; `capsConsistent` is the kernel's own
consistency condition, so an inventory edit that contradicts the exclusions
fails to certify.

`profileValid caps p` is decidable and says only that `p` stays inside that
inventory and under those ceilings. Neither the generator nor an arbitrarily
edited inventory is proved safe by anything here: expanding the inventory is a
kernel change that needs its own security review.
-/

namespace Guard

open V

structure Capabilities where
  version : Nat
  /-- Absolute upper bounds. A profile may lower these, never raise them. -/
  ceilings : Limits
  sharedAttrs : Table
  htmlAttrs : Table
  svgAttrs : Table
  htmlElements : List (String × Table)
  svgElements : List (String × Table)
  /-- Control attributes every profile keeping the element must force. -/
  forced : List (String × List (String × String))
  /-- Attributes the checker must always be able to emit on the element. -/
  requiredAttrs : List (String × List String)
  unwrappable : List String
  textOnlySvg : List String
  excludedHtmlElements : List String
  excludedSvgElements : List String
  excludedAttrs : List String

def Capabilities.globalTable (c : Capabilities) (ns : Ns) : Table :=
  if ns == .html then c.htmlAttrs else c.svgAttrs

def Capabilities.elements (c : Capabilities) (ns : Ns) : List (String × Table) :=
  if ns == .html then c.htmlElements else c.svgElements

def Capabilities.elementTable (c : Capabilities) (ns : Ns) (tag : String) : Option Table :=
  (c.elements ns).lookup tag

def Capabilities.excludedElements (c : Capabilities) (ns : Ns) : List String :=
  if ns == .html then c.excludedHtmlElements else c.excludedSvgElements

/-- The namespace-global or shared grammar for `name`. -/
def Capabilities.globalOrShared (c : Capabilities) (ns : Ns) (name : String) : Option Val :=
  ((c.globalTable ns).lookup name).orElse (fun _ => c.sharedAttrs.lookup name)

/-- The widest grammar the kernel reviewed for `name` in this element context:
the element's own entry, else the namespace-global or shared entry. -/
def Capabilities.attrFor (c : Capabilities) (ns : Ns) (table : Table) (name : String) : Option Val :=
  (table.lookup name).orElse (fun _ => c.globalOrShared ns name)

/-- `name` occurs in no attribute table of the inventory, in any context. -/
def capAttrAbsent (c : Capabilities) (name : String) : Bool :=
  (c.sharedAttrs.lookup name).isNone &&
  allNs.all fun ns =>
    ((c.globalTable ns).lookup name).isNone &&
    (c.elements ns).all (fun e => (e.2.lookup name).isNone)

/-- No element table shadows a namespace-global or shared attribute, so a
global attribute's grammar is the same in every element context. -/
def capNoShadow (c : Capabilities) : Bool :=
  allNs.all fun ns =>
    ((c.globalTable ns) ++ c.sharedAttrs).all fun entry =>
      (c.elements ns).all fun el => (el.2.lookup entry.1).isNone

/--
The kernel's own consistency condition: nothing it excludes may also appear in
its inventory, an unwrappable element is never also permitted, and element
tables never shadow global attributes. This is what makes the exclusion
theorems independent of the mutable profile -- they are stated about the
reviewed inventory, and a future inventory edit that permits an excluded
identity fails to certify.
-/
def capsConsistent (c : Capabilities) : Bool :=
  c.excludedAttrs.all (capAttrAbsent c) &&
  c.excludedHtmlElements.all (fun t => (c.elementTable .html t).isNone) &&
  c.excludedSvgElements.all (fun t => (c.elementTable .svg t).isNone) &&
  c.unwrappable.all (fun t => (c.elementTable .html t).isNone) &&
  capNoShadow c

/-- Every name a profile resolves for this element must be in the inventory
with a wider-or-equal grammar. -/
def capTableValid (c : Capabilities) (p : Profile) (ns : Ns) (t : Table) (capTable : Table) : Bool :=
  (t ++ p.globalTable ns).all fun entry =>
    match p.attrFor ns t entry.1, c.attrFor ns capTable entry.1 with
    | some v, some w => v.restricts w
    | none, _ => true
    | _, none => false

def capElementsValid (c : Capabilities) (p : Profile) (ns : Ns) : Bool :=
  (p.elements ns).all fun entry =>
    match c.elementTable ns entry.1 with
    | none => false
    | some capTable => capTableValid c p ns entry.2 capTable

/-- A global table entry must be in the inventory for every element context,
so it is checked against the namespace and shared inventories directly. -/
def capGlobalValid (c : Capabilities) (ns : Ns) (t : Table) : Bool :=
  t.all fun entry =>
    match c.globalOrShared ns entry.1 with
    | none => false
    | some w => entry.2.restricts w

def capForcedKept (c : Capabilities) (p : Profile) : Bool :=
  c.forced.all fun entry =>
    match p.elementTable .html entry.1 with
    | none => true  -- dropping the element entirely is a restriction
    | some _ => entry.2.all fun pair => (((p.htmlForced.lookup entry.1).getD []).lookup pair.1) == some pair.2

def capRequiredKept (c : Capabilities) (p : Profile) : Bool :=
  c.requiredAttrs.all fun entry =>
    match p.elementTable .html entry.1 with
    | none => true
    | some t => entry.2.all fun name => (p.attrFor .html t name).isSome

def capTextOnlyKept (c : Capabilities) (p : Profile) : Bool :=
  c.textOnlySvg.all fun tag => (p.elementTable .svg tag).isNone || p.svgTextOnly.contains tag

def capUnwrapClosed (c : Capabilities) (p : Profile) : Bool :=
  p.htmlUnwrap.all fun tag => c.unwrappable.contains tag

/--
Profile well-formedness: `p` stays within the reviewed capability set and
under the kernel's hard limits. Nothing more is claimed.
-/
def profileValid (c : Capabilities) (p : Profile) : Bool :=
  (allNs.all fun ns => capGlobalValid c ns (p.globalTable ns) && capElementsValid c p ns) &&
  capForcedKept c p && capRequiredKept c p && capTextOnlyKept c p &&
  capUnwrapClosed c p && p.limits.within c.ceilings

end Guard
