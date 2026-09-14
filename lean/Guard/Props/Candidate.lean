import Guard.Policy.Candidate
import Guard.Props.Profile

/-!
Candidate-acceptance proofs, separate from the production dependency graph.
These extend the output-policy proofs with explicit representation invariants.
The connection to the reference normalizer is a separate obligation: acceptance
must not be switched to this checker until that obligation is discharged.
-/
namespace Guard.Props

theorem candidate_permits {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate prof ctx tree = true) : prof.permits ctx tree = true := by
  simp only [acceptCandidate, Bool.and_eq_true] at h
  exact h.1

theorem candidate_representation {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate prof ctx tree = true) : nodesRepresentationOk prof tree = true := by
  simp only [acceptCandidate, Bool.and_eq_true] at h
  exact h.2

theorem candidate_node_bound {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate prof ctx tree = true) : (treeStats tree).1 ≤ prof.limits.maxNodes :=
  permits_nodeBound (candidate_permits h)

theorem candidate_text_bound {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate prof ctx tree = true) : (treeStats tree).2 ≤ prof.limits.maxTotalText :=
  permits_textBound (candidate_permits h)

theorem candidate_descendant {prof : Profile} {ctx : Ctx} {tree : List Node} {node : Node}
    (h : acceptCandidate prof ctx tree = true) (occurs : InTree node tree) :
    ∃ p d t, nodePolicyOk prof ctx p d t node = true :=
  descendant_checked (permits_nodes (candidate_permits h)) occurs

theorem representation_member {prof : Profile} {tree : List Node} {node : Node}
    (h : nodesRepresentationOk prof tree = true) (member : node ∈ tree) :
    nodeRepresentationOk prof node = true := by
  induction tree with
  | nil => simp at member
  | cons n ns ih =>
    simp only [nodesRepresentationOk, Bool.and_eq_true] at h
    rcases List.mem_cons.mp member with rfl | rest
    · exact h.1
    · exact ih h.2 rest

theorem representation_descendant {prof : Profile} {tree : List Node} {node : Node}
    (h : nodesRepresentationOk prof tree = true) (occurs : InTree node tree) :
    nodeRepresentationOk prof node = true := by
  induction occurs with
  | top member => exact representation_member h member
  | child member _ ih =>
    have he := representation_member h member
    simp only [nodeRepresentationOk, Bool.and_eq_true] at he
    exact ih he.2

theorem candidate_sorted_attrs {prof : Profile} {ctx : Ctx} {tree : List Node}
    {ns : Ns} {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : acceptCandidate prof ctx tree = true)
    (occurs : InTree (.el ns tag attrs children) tree) :
    attrs.Pairwise (fun a b => a.1 ≤ b.1 ∧ a.1 ≠ b.1) := by
  have hr := representation_descendant (candidate_representation h) occurs
  simp only [nodeRepresentationOk, Bool.and_eq_true, orderedAttrs, decide_eq_true_eq] at hr
  exact hr.1.1.2

theorem candidate_unique_attrs {prof : Profile} {ctx : Ctx} {tree : List Node}
    {ns : Ns} {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : acceptCandidate prof ctx tree = true)
    (occurs : InTree (.el ns tag attrs children) tree) : (attrs.map Prod.fst).Nodup := by
  have hs := candidate_sorted_attrs h occurs
  rw [List.Nodup, List.pairwise_map]
  exact hs.imp (fun hab => hab.2)

theorem candidate_attribute_validator {prof : Profile} {ctx : Ctx} {tree : List Node}
    {ns : Ns} {tag name value : String} {attrs : List (String × String)} {children : List Node}
    (h : acceptCandidate prof ctx tree = true)
    (occurs : InTree (.el ns tag attrs children) tree) (member : (name, value) ∈ attrs) :
    ∃ table v, prof.elementTable ns tag = some table ∧
      prof.attrFor ns table name = some v ∧ v.apply ctx value = some value := by
  obtain ⟨_, _, _, hn⟩ := candidate_descendant h occurs
  obtain ⟨table, hel, ha, _⟩ := allowed_element hn
  obtain ⟨v, hv, hc⟩ := attribute_validator (List.all_eq_true.mp (attrsCanonical_all ha) _ member)
  exact ⟨table, v, hel, hv, hc⟩

theorem candidate_no_excluded_element {prof : Profile} {ctx : Ctx} {tree : List Node}
    (valid : profileValid caps prof = true) {ns : Ns} {tag : String}
    {attrs : List (String × String)} {children : List Node}
    (h : acceptCandidate prof ctx tree = true)
    (occurs : InTree (.el ns tag attrs children) tree) : tag ∉ caps.excludedElements ns := by
  intro excluded
  obtain ⟨_, _, _, hn⟩ := candidate_descendant h occurs
  obtain ⟨_, hel, _⟩ := allowed_element hn
  rw [valid_excludes_element caps_consistent valid excluded] at hel
  cases hel

theorem candidate_no_excluded_attribute {prof : Profile} {ctx : Ctx} {tree : List Node}
    (valid : profileValid caps prof = true) {ns : Ns} {tag name value : String}
    {attrs : List (String × String)} {children : List Node}
    (h : acceptCandidate prof ctx tree = true)
    (occurs : InTree (.el ns tag attrs children) tree) (member : (name, value) ∈ attrs) :
    name ∉ caps.excludedAttrs := by
  intro excluded
  obtain ⟨_, _, hel, ha, _⟩ := candidate_attribute_validator h occurs member
  rw [valid_excludes_attr caps_consistent valid excluded hel] at ha
  cases ha

theorem candidate_restricts_permits {p2 p1 : Profile} {ctx : Ctx} {tree : List Node}
    (restriction : profileRestricts p2 p1 = true)
    (h : acceptCandidate p2 ctx tree = true) : p1.permits ctx tree = true :=
  restricts_permits restriction (candidate_permits h)

end Guard.Props
