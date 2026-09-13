import Guard.Policy.Check

/-!
Whole-checker theorems. Acceptance is certified by a structural postcondition
and a second normalization. These theorems do not claim that every candidate
from the normalizer is safe, nor that browser rendering is formally modeled.

The structural lemmas are stated for an arbitrary profile so that
`Guard.Props.Profile` can reuse them; the `accepted_*` theorems are about
production acceptance, which always runs `defaultProfile`.
-/

namespace Guard.Props

def IsValidated (ctx : Ctx) (tree : List Node) : Prop :=
  checkTree ctx (nodesToRaw tree) = .validated tree []

theorem accepted_policy {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) : policyOk ctx tree = true := by
  unfold checkTree at h
  split at h
  · cases h
  · split at h
    · split at h
      · cases h; assumption
      · cases h
    · cases h

theorem accepted_normalization {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) :
    normalizeTree ctx (nodesToRaw tree) = .validated tree [] := by
  unfold checkTree at h
  split at h
  · cases h
  · split at h
    · split at h
      · cases h; assumption
      · cases h
    · cases h

theorem accepted_idempotent {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) : IsValidated ctx tree := by
  have hp := accepted_policy h
  have hn := accepted_normalization h
  simp [IsValidated, checkTree, hp, hn]

theorem accepted_structure {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) :
    nodesPolicyOk defaultProfile ctx .html 0 false tree = true := by
  have hp := accepted_policy h
  simp only [policyOk, Profile.permits, Bool.and_eq_true, decide_eq_true_eq] at hp
  exact hp.1.1

theorem accepted_node_bound {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) :
    (treeStats tree).1 ≤ defaultProfile.limits.maxNodes := by
  have hp := accepted_policy h
  simp only [policyOk, Profile.permits, Bool.and_eq_true, decide_eq_true_eq] at hp
  exact hp.1.2

theorem accepted_text_bound {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    (h : checkTree ctx raws = .validated tree changes) :
    (treeStats tree).2 ≤ defaultProfile.limits.maxTotalText := by
  have hp := accepted_policy h
  simp only [policyOk, Profile.permits, Bool.and_eq_true, decide_eq_true_eq] at hp
  exact hp.2

/-- Every node at a checked level satisfies the node predicate, not merely
the root. The node predicate recursively requires this for its children. -/
theorem nodesPolicyOk_member {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {nodes : List Node} {node : Node} (h : nodesPolicyOk prof ctx parent depth textOnly nodes = true)
    (member : node ∈ nodes) : nodePolicyOk prof ctx parent depth textOnly node = true := by
  induction nodes with
  | nil => cases member
  | cons n ns ih =>
    simp only [nodesPolicyOk, Bool.and_eq_true] at h
    rcases List.mem_cons.mp member with same | rest
    · subst node; exact h.1
    · exact ih h.2 rest

theorem allowed_element {prof : Profile} {ctx : Ctx} {parent ns : Ns} {depth : Nat} {textOnly : Bool}
    {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : nodePolicyOk prof ctx parent depth textOnly (.el ns tag attrs children) = true) :
    ∃ table, prof.elementTable ns tag = some table ∧
      attrsCanonical prof ctx ns tag table attrs = true ∧
      nodesPolicyOk prof ctx ns (depth + 1) (ns == .svg && prof.svgTextOnly.contains tag) children = true := by
  cases ht : prof.elementTable ns tag with
  | none => simp [nodePolicyOk, ht] at h
  | some table =>
    simp only [nodePolicyOk, ht, Bool.and_eq_true, decide_eq_true_eq] at h
    exact ⟨table, rfl, h.2.1, h.2.2⟩

theorem attribute_has_no_handler_or_prefix {prof : Profile} {ctx : Ctx} {ns : Ns} {table : Table}
    {name value : String} (h : attrCanonical prof ctx ns table (name, value) = true) :
    name.contains ':' = false ∧ name.startsWith "on" = false := by
  cases hc : name.contains ':' <;> cases ho : name.startsWith "on" <;>
    simp_all [attrCanonical]

/-- The profile validator that accepted an attribute, together with the fact
that it returned the value unchanged. -/
theorem attribute_validator {prof : Profile} {ctx : Ctx} {ns : Ns} {table : Table}
    {name value : String} (h : attrCanonical prof ctx ns table (name, value) = true) :
    ∃ v, prof.attrFor ns table name = some v ∧ v.apply ctx value = some value := by
  cases hv : prof.attrFor ns table name with
  | none => simp [attrCanonical, hv] at h
  | some v =>
    refine ⟨v, rfl, ?_⟩
    simp only [attrCanonical, hv, Bool.and_eq_true, beq_iff_eq] at h
    exact h.2

/-- Membership at any nesting depth, including elements inside SVG. -/
inductive InTree (node : Node) : List Node → Prop where
  | top {tree} : node ∈ tree → InTree node tree
  | child {ns tag attrs children tree} : Node.el ns tag attrs children ∈ tree →
      InTree node children → InTree node tree

theorem descendant_checked {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {tree : List Node} {node : Node} (h : nodesPolicyOk prof ctx parent depth textOnly tree = true)
    (occurs : InTree node tree) :
    ∃ p d t, nodePolicyOk prof ctx p d t node = true := by
  induction occurs generalizing parent depth textOnly with
  | top member => exact ⟨parent, depth, textOnly, nodesPolicyOk_member h member⟩
  | child member _ ih =>
    obtain ⟨_, _, _, childrenOk⟩ := allowed_element (nodesPolicyOk_member h member)
    exact ih childrenOk

theorem accepted_descendant {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    {node : Node} (h : checkTree ctx raws = .validated tree changes) (occurs : InTree node tree) :
    ∃ p d t, nodePolicyOk defaultProfile ctx p d t node = true :=
  descendant_checked (accepted_structure h) occurs

theorem accepted_element_allowed {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    {ns : Ns} {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes) (occurs : InTree (.el ns tag attrs children) tree) :
    ∃ table, defaultProfile.elementTable ns tag = some table ∧
      attrsCanonical defaultProfile ctx ns tag table attrs = true := by
  obtain ⟨_, _, _, checked⟩ := accepted_descendant h occurs
  obtain ⟨table, allowed, attrsOk, _⟩ := allowed_element checked
  exact ⟨table, allowed, attrsOk⟩

theorem script_not_allowed (ns : Ns) : defaultProfile.elementTable ns "script" = none := by
  cases ns <;> rfl

theorem accepted_no_script {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    {ns : Ns} {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes) :
    ¬ InTree (.el ns "script" attrs children) tree := by
  intro occurs
  obtain ⟨_, allowed, _⟩ := accepted_element_allowed h occurs
  rw [script_not_allowed] at allowed
  cases allowed

theorem accepted_no_handler {ctx : Ctx} {raws : List Raw} {tree : List Node} {changes : List Change}
    {ns : Ns} {tag name value : String} {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes) (occurs : InTree (.el ns tag attrs children) tree)
    (member : (name, value) ∈ attrs) : name.startsWith "on" = false ∧ name.contains ':' = false := by
  obtain ⟨_, _, attrsOk⟩ := accepted_element_allowed h occurs
  simp only [attrsCanonical, Bool.and_eq_true, decide_eq_true_eq] at attrsOk
  have canonical := List.all_eq_true.mp attrsOk.1.2 (name, value) member
  have noHandler := attribute_has_no_handler_or_prefix canonical
  exact ⟨noHandler.2, noHandler.1⟩

/-- The validator the shipped profile used for an accepted attribute. This is
the bridge from acceptance to the value contracts in `Guard.Props.Profile`. -/
theorem accepted_attribute_validator {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {ns : Ns} {tag name value : String}
    {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el ns tag attrs children) tree) (member : (name, value) ∈ attrs) :
    ∃ table v, defaultProfile.elementTable ns tag = some table ∧
      defaultProfile.attrFor ns table name = some v ∧ v.apply ctx value = some value := by
  obtain ⟨table, allowed, attrsOk⟩ := accepted_element_allowed h occurs
  simp only [attrsCanonical, Bool.and_eq_true, decide_eq_true_eq] at attrsOk
  have canonical := List.all_eq_true.mp attrsOk.1.2 (name, value) member
  obtain ⟨v, found, applied⟩ := attribute_validator canonical
  exact ⟨table, v, allowed, found, applied⟩

end Guard.Props
