import Guard

/-!
Table invariants. These hold the policy tables to the conventions the
JavaScript tables follow, so the differential cannot drift on table shape.
Checks are named defs so `#guard` can evaluate them.
-/

open Guard

def isLowerAscii (s : String) : Bool := s.toList.all fun c => !(c ≥ 'A' && c ≤ 'Z')

-- HTML element names are lowercase (the checker lowercases before lookup).
def htmlTagsLower : Bool := htmlElements.all fun p => isLowerAscii p.1
#guard htmlTagsLower
def unwrapLower : Bool := htmlUnwrap.all fun p => isLowerAscii p.1
#guard unwrapLower

-- No element is both allowed and unwrapped, or allowed and in a drop-rule map.
def unwrapDisjoint : Bool := htmlUnwrap.all fun p => (htmlElements.lookup p.1).isNone
#guard unwrapDisjoint
def htmlDropDisjoint : Bool := htmlDropRules.all fun p => (htmlElements.lookup p.1).isNone && (htmlUnwrap.lookup p.1).isNone
#guard htmlDropDisjoint
def svgDropDisjoint : Bool := svgDropRules.all fun p => (svgElements.lookup p.1).isNone
#guard svgDropDisjoint

-- Drop-rule keys are lowercase (the checker lowercases before lookup).
def dropKeysLower : Bool := (htmlDropRules ++ svgDropRules ++ attrDropRules).all fun p => isLowerAscii p.1
#guard dropKeysLower

-- Every rule cited by a table is a catalog rule.
def tableRulesKnown : Bool :=
  (htmlDropRules ++ svgDropRules ++ attrDropRules ++ htmlUnwrap).all fun p => R.isRule p.2
#guard tableRulesKnown
def allTables : Table :=
  htmlGlobal ++ svgGlobal ++
  htmlElements.foldl (fun (acc : Table) (p : String × Table) => acc ++ p.2) [] ++
  svgElements.foldl (fun (acc : Table) (p : String × Table) => acc ++ p.2) []
def valRulesKnown : Bool := allTables.all fun p => R.isRule p.2.rule
#guard valRulesKnown

-- Attribute drop rules never name an attribute that some table allows.
def attrDropNotAllowed : Bool :=
  attrDropRules.all fun p =>
    (htmlGlobal.lookup p.1).isNone && (svgGlobal.lookup p.1).isNone &&
    htmlElements.all (fun e => (e.2.lookup p.1).isNone) && svgElements.all (fun e => (e.2.lookup p.1).isNone)
#guard attrDropNotAllowed

-- SVG canonical-name map is keyed by lowercase names.
def svgCanonicalLower : Bool := svgCanonical.all fun p => isLowerAscii p.1
#guard svgCanonicalLower

-- Every generated rule id has the expected shape.
#guard R.all.all fun id => id.startsWith "R-"
#guard R.all.length == 43
