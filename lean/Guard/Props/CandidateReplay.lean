import Guard.Props.Candidate
import Init.Data.List.Sort.Lemmas

namespace Guard.Props

theorem ns_beq_eq (a b : Ns) : (a == b) = decide (a = b) := by
  cases a <;> cases b <;> rfl

theorem checkAttrStep_fixed {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {path : List Nat} {name value : String} {count : Nat} {seen : List (String × String)}
    (hc : count + 1 ≤ limits.maxAttrs)
    (hn : canonicalAttrName ns name = name)
    (hv : attrCanonical defaultProfile ctx ns table (name, value) = true)
    (hl : utf16Length value ≤ limits.maxAttrValueLength * 10)
    (ha : seen.lookup name = none) :
    checkAttrStep ctx ns tag table path (name, value) (count, seen) =
      pure (.yield (count + 1, seen ++ [(name, value)])) := by
  obtain ⟨v, found, applied⟩ := attribute_validator hv
  obtain ⟨noColon, noHandler⟩ := attribute_has_no_handler_or_prefix hv
  have notCount : ¬count + 1 > limits.maxAttrs := by omega
  have notLength : ¬utf16Length value > limits.maxAttrValueLength * 10 := by omega
  change (if ns == .svg then (svgCanonical.lookup (V.asciiLower name)).getD (V.asciiLower name)
    else V.asciiLower name) = name at hn
  change (table.lookup name).orElse (fun _ => (if ns == .html then htmlGlobal else svgGlobal).lookup name)
    = some v at found
  simp [checkAttrStep, hn, notCount, noColon, noHandler, found, notLength, applied, ha]

theorem checkAttrLoop_fixed {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {path : List Nat} (attrs : List (String × String)) (seen : List (String × String)) (count : Nat)
    (hc : count + attrs.length ≤ limits.maxAttrs)
    (hp : ∀ pair ∈ attrs, canonicalAttrName ns pair.1 = pair.1 ∧
      attrCanonical defaultProfile ctx ns table pair = true ∧
      utf16Length pair.2 ≤ limits.maxAttrValueLength * 10)
    (hu : (attrs.map Prod.fst).Nodup)
    (ha : ∀ pair ∈ attrs, seen.lookup pair.1 = none) :
    forIn attrs (count, seen) (checkAttrStep ctx ns tag table path) =
      pure (count + attrs.length, seen ++ attrs) := by
  induction attrs generalizing seen count with
  | nil => simp
  | cons pair rest ih =>
    rcases pair with ⟨name, value⟩
    obtain ⟨hn, hv, hl⟩ := hp (name, value) (by simp)
    have hcount : count + 1 ≤ limits.maxAttrs := by simp only [List.length_cons] at hc; omega
    rw [List.forIn_cons, checkAttrStep_fixed hcount hn hv hl (ha _ (by simp))]
    simp only [pure_bind]
    have hu' : name ∉ rest.map Prod.fst ∧ (rest.map Prod.fst).Nodup := by
      simpa only [List.map_cons, List.nodup_cons] using hu
    have hlookup : ∀ p ∈ rest, (seen ++ [(name, value)]).lookup p.1 = none := by
      intro p member
      have hne : p.1 ≠ name := by
        intro same
        apply hu'.1
        rw [← same]
        exact List.mem_map.mpr ⟨p, member, rfl⟩
      have hbeq : (p.1 == name) = false := by simp [beq_iff_eq, hne]
      simp [List.lookup_append, ha p (by simp [member]), List.lookup_cons, hbeq]
    rw [ih (seen ++ [(name, value)]) (count + 1)
      (by simp only [List.length_cons] at hc; omega)
      (fun p h => hp p (by simp [h])) hu'.2 hlookup]
    simp [List.append_assoc, Nat.add_assoc, Nat.add_comm, Nat.add_left_comm]

theorem forceAttrLoop_fixed (forced attrs : List (String × String))
    (h : ∀ pair ∈ forced, (attrs.lookup pair.1).isSome = true) :
    forIn forced attrs forceAttrStep = pure attrs := by
  induction forced with
  | nil => simp
  | cons pair rest ih =>
    have hp := h pair (by simp)
    have hn : (attrs.lookup pair.1).isNone = false := by
      cases hf : attrs.lookup pair.1 <;> simp_all
    rw [List.forIn_cons]
    simp only [forceAttrStep, hn, Bool.false_eq_true, ↓reduceIte, pure_bind]
    exact ih (fun p member => h p (by simp [member]))

theorem sortAttrs_fixed (attrs : List (String × String))
    (h : attrs.Pairwise (fun a b => a.1 ≤ b.1 ∧ a.1 ≠ b.1)) : sortAttrs attrs = attrs := by
  apply List.mergeSort_of_sorted
  apply h.imp
  intro a b hab
  simp only [decide_eq_true_eq]
  exact hab.1

theorem checkAttrs_fixed {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {path : List Nat} {attrs : List (String × String)}
    (hp : attrsCanonical defaultProfile ctx ns tag table attrs = true)
    (hr : attrs.all (fun (name, value) => canonicalAttrName ns name == name &&
      utf16Length value ≤ limits.maxAttrValueLength * 10) = true)
    (hs : orderedAttrs attrs = true) :
    checkAttrs ctx ns tag table path attrs = pure attrs := by
  have sorted : attrs.Pairwise (fun a b => a.1 ≤ b.1 ∧ a.1 ≠ b.1) := by
    simpa only [orderedAttrs, decide_eq_true_eq] using hs
  have unique : (attrs.map Prod.fst).Nodup := by
    rw [List.Nodup, List.pairwise_map]
    exact sorted.imp (fun h => h.2)
  have pairs : ∀ pair ∈ attrs, canonicalAttrName ns pair.1 = pair.1 ∧
      attrCanonical defaultProfile ctx ns table pair = true ∧
      utf16Length pair.2 ≤ limits.maxAttrValueLength * 10 := by
    intro pair member
    have r := List.all_eq_true.mp hr pair member
    simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at r
    exact ⟨r.1, List.all_eq_true.mp (attrsCanonical_all hp) pair member, r.2⟩
  unfold checkAttrs
  rw [checkAttrLoop_fixed attrs [] 0 (by simpa using attrsCanonical_len hp)
    pairs unique (by intros; rfl)]
  simp only [pure_bind, List.nil_append]
  split
  next html =>
    have hns : ns = .html := by
      cases ns with
      | html => rfl
      | svg => change false = true at html; contradiction
    subst ns
    have forced : ∀ pair ∈ (htmlForced.lookup tag).getD [], (attrs.lookup pair.1).isSome = true := by
      intro pair member
      have hf := List.all_eq_true.mp (attrsCanonical_forced hp) pair member
      simp only [beq_iff_eq] at hf
      simp [hf]
    rw [forceAttrLoop_fixed _ attrs forced]
    simp only [pure_bind]
    have input : (tag == "input" && (attrs.lookup "type").isNone) = false := by
      by_cases ht : tag = "input"
      · subst tag
        have hi := attrsCanonical_inputType hp
        cases ha : attrs.lookup "type" <;> simp_all
      · simp [beq_iff_eq, ht]
    simp [input, sortAttrs_fixed attrs sorted]
  next => simp [sortAttrs_fixed attrs sorted]

def addTreeStats (st : St) (tree : List Node) : St :=
  { st with
    nodes := st.nodes + (treeStats tree).1
    totalText := st.totalText + (treeStats tree).2 }

theorem checkTextStep_fixed {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {fuel : Nat} {path : List Nat} {index : Nat} {out : List Node} {s : String} {st : St}
    (hp : nodePolicyOk defaultProfile ctx parent depth textOnly (.text s) = true)
    (hlen : utf16Length s ≠ 0)
    (hr : st.reasons = [])
    (hn : st.nodes + 1 ≤ limits.maxNodes)
    (ht : st.totalText + utf16Length s ≤ limits.maxTotalText) :
    (checkChildStep fuel ctx parent depth depth path textOnly (.text s) (index, out)).run st =
      (.yield (index + 1, out ++ [.text s]), addTreeStats st [.text s]) := by
  simp only [nodePolicyOk, Bool.and_eq_true, Bool.not_eq_true, beq_iff_eq, decide_eq_true_eq] at hp
  simp [checkChildStep, rejected, hr, hp.1.2, hlen,
    show ¬utf16Length s > limits.maxTextLength from by have := hp.2; change utf16Length s ≤ limits.maxTextLength at this; omega,
    show ¬st.nodes + 1 > limits.maxNodes from by omega,
    show ¬st.totalText + utf16Length s > limits.maxTotalText from by omega,
    StateT.run, StateT.bind, StateT.pure, StateT.get, StateT.set, StateT.modifyGet,
    get, getThe, MonadStateOf.get, MonadStateOf.modifyGet, modify, modifyGet, bind, pure,
    addTreeStats, treeStats, nodeStats]

theorem checkElement_fixed {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {attrs : List (String × String)} {children : List Node} {fuel depth : Nat}
    {path : List Nat} {st : St}
    (hp : attrsCanonical defaultProfile ctx ns tag table attrs = true)
    (hr : attrs.all (fun (name, value) => canonicalAttrName ns name == name &&
      utf16Length value ≤ limits.maxAttrValueLength * 10) = true)
    (hs : orderedAttrs attrs = true)
    (hn : st.nodes + 1 ≤ limits.maxNodes)
    (hk : (checkChildren fuel ctx (nodesToRaw children) ns (depth + 1) (depth + 1) path
      (ns == .svg && svgTextOnly.contains tag)).run { st with nodes := st.nodes + 1 } =
        (children, addTreeStats { st with nodes := st.nodes + 1 } children)) :
    (checkElement (fuel + 1) ctx ns tag table attrs (nodesToRaw children) depth (depth + 1) path).run st =
      (.el ns tag attrs children, addTreeStats st [.el ns tag attrs children]) := by
  simp only [StateT.run] at hk ⊢
  simp at hk
  simp [checkElement, checkAttrs_fixed hp hr hs,
    show ¬st.nodes + 1 > limits.maxNodes from by omega,
    StateT.bind, StateT.pure, StateT.get, StateT.modifyGet,
    get, getThe, MonadStateOf.get, MonadStateOf.modifyGet, modify, modifyGet, bind, pure,
    hk, addTreeStats, treeStats, nodeStats, Nat.add_assoc, Nat.add_comm, Nat.add_left_comm]

theorem checkElStep_fixed {ctx : Ctx} {parent ns : Ns} {tag : String}
    {attrs : List (String × String)} {children : List Node} {fuel depth : Nat}
    {path : List Nat} {index : Nat} {out : List Node} {textOnly : Bool} {st : St}
    (hp : nodePolicyOk defaultProfile ctx parent depth textOnly (.el ns tag attrs children) = true)
    (hn : V.asciiLower tag = tag) (hr : st.reasons = [])
    (he : ∀ table, defaultProfile.elementTable ns tag = some table →
      (checkElement fuel ctx ns tag table attrs (nodesToRaw children) depth (depth + 1)
        (path ++ [index])).run st =
          (.el ns tag attrs children, addTreeStats st [.el ns tag attrs children])) :
    (checkChildStep fuel ctx parent depth depth path textOnly
      (Node.el ns tag attrs children).toRaw (index, out)).run st =
        (.yield (index + 1, out ++ [.el ns tag attrs children]), addTreeStats st [.el ns tag attrs children]) := by
  obtain ⟨table, hel, _, _⟩ := allowed_element hp
  have he' := he table hel
  have htext := el_textOnly hp
  have hdepth : depth + 1 ≤ limits.maxDepth := el_depth hp
  have hns := el_nsOk hp
  simp only [StateT.run] at he' ⊢
  cases ns <;> cases parent <;>
    simp_all [checkChildStep, Node.toRaw, Ns.toString, rejected, Profile.elementTable, ns_beq_eq, bne,
      Profile.elements, defaultProfile, show ¬depth + 1 > limits.maxDepth from by omega,
      StateT.bind, StateT.pure, StateT.get, StateT.modifyGet,
      get, getThe, MonadStateOf.get, MonadStateOf.modifyGet, modify, modifyGet, bind, pure]

theorem checkChildren_fixed (fuel : Nat) (ctx : Ctx) (tree : List Node)
    (parent : Ns) (depth : Nat) (path : List Nat) (textOnly : Bool) (st : St)
    (hf : 2 * rawWeight (nodesToRaw tree) + 1 ≤ fuel)
    (hd : depth ≤ limits.maxDepth)
    (hp : nodesPolicyOk defaultProfile ctx parent depth textOnly tree = true)
    (hr : nodesRepresentationOk defaultProfile tree = true)
    (hs : st.reasons = [])
    (hn : st.nodes + (treeStats tree).1 ≤ limits.maxNodes)
    (ht : st.totalText + (treeStats tree).2 ≤ limits.maxTotalText) :
    (checkChildren fuel ctx (nodesToRaw tree) parent depth depth path textOnly).run st =
      (tree, addTreeStats st tree) := by
  induction fuel using Nat.strongRecOn generalizing tree parent depth path textOnly st with
  | ind fuel ih =>
    cases fuel with
    | zero => omega
    | succ f =>
      have depthOk : ¬depth > limits.maxTraversalDepth := by
        have ceiling : limits.maxDepth ≤ limits.maxTraversalDepth := by decide
        omega
      have loop : ∀ (ts : List Node) (index : Nat) (out : List Node) (s : St),
          2 * rawWeight (nodesToRaw ts) + 1 ≤ f + 1 →
          nodesPolicyOk defaultProfile ctx parent depth textOnly ts = true →
          nodesRepresentationOk defaultProfile ts = true →
          s.reasons = [] → s.nodes + (treeStats ts).1 ≤ limits.maxNodes →
          s.totalText + (treeStats ts).2 ≤ limits.maxTotalText →
          (forIn (nodesToRaw ts) (index, out)
            (checkChildStep f ctx parent depth depth path textOnly)).run s =
              ((index + ts.length, out ++ ts), addTreeStats s ts) := by
        intro ts
        induction ts with
        | nil => intros; simp [nodesToRaw, addTreeStats, treeStats, StateT.run, pure, StateT.pure]
        | cons node rest tail =>
          intro index out s hfuel hpolicy hrepr hstate hnodes htext
          simp only [nodesPolicyOk, Bool.and_eq_true] at hpolicy
          simp only [nodesRepresentationOk, Bool.and_eq_true] at hrepr
          have headNodes : s.nodes + (nodeStats node).1 ≤ limits.maxNodes := by
            simp only [treeStats] at hnodes; omega
          have headText : s.totalText + (nodeStats node).2 ≤ limits.maxTotalText := by
            simp only [treeStats] at htext; omega
          have step : (checkChildStep f ctx parent depth depth path textOnly node.toRaw
              (index, out)).run s =
                (.yield (index + 1, out ++ [node]), addTreeStats s [node]) := by
            cases node with
            | text value =>
              apply checkTextStep_fixed hpolicy.1
              · simpa [nodeRepresentationOk, bne] using hrepr.1
              · exact hstate
              · exact headNodes
              · exact headText
            | el ns tag attrs children =>
              have repr := hrepr.1
              simp only [nodeRepresentationOk, Bool.and_eq_true, beq_iff_eq] at repr
              apply checkElStep_fixed hpolicy.1 repr.1.1.1 hstate
              intro table allowed
              have fields := allowed_element hpolicy.1
              obtain ⟨table', allowed', attrsOk, kidsOk⟩ := fields
              have tableEq : table' = table := by rw [allowed] at allowed'; exact Option.some.inj allowed'.symm
              subst table'
              cases f with
              | zero => simp only [nodesToRaw, Node.toRaw, rawWeight, Raw.weight] at hfuel; omega
              | succ f' =>
                apply checkElement_fixed attrsOk repr.1.2 repr.1.1.2
                · simp only [nodeStats] at headNodes; omega
                · apply ih f' (by omega) children ns (depth + 1) (path ++ [index])
                    (ns == .svg && svgTextOnly.contains tag) { s with nodes := s.nodes + 1 }
                  · simp only [nodesToRaw, Node.toRaw, rawWeight, Raw.weight] at hfuel; omega
                  · exact el_depth hpolicy.1
                  · exact kidsOk
                  · exact repr.2
                  · exact hstate
                  · simp only [nodeStats] at headNodes; dsimp; omega
                  · exact headText
          have restFuel : 2 * rawWeight (nodesToRaw rest) + 1 ≤ f + 1 := by
            simp only [nodesToRaw, rawWeight] at hfuel; omega
          have restNodes : (addTreeStats s [node]).nodes + (treeStats rest).1 ≤ limits.maxNodes := by
            simp only [addTreeStats, treeStats] at *; omega
          have restText : (addTreeStats s [node]).totalText + (treeStats rest).2 ≤ limits.maxTotalText := by
            simp only [addTreeStats, treeStats] at *; omega
          have restResult := tail (index + 1) (out ++ [node]) (addTreeStats s [node])
            restFuel hpolicy.2 hrepr.2 hstate restNodes restText
          simp only [StateT.run] at step restResult ⊢
          simp only [nodesToRaw, List.forIn_cons, bind, pure, StateT.bind, StateT.pure,
            step, restResult]
          simp [addTreeStats, treeStats, Nat.add_assoc, Nat.add_comm,
            Nat.add_left_comm, List.append_assoc]
      have result := loop tree 0 [] st hf hp hr hs hn ht
      simp only [StateT.run] at result ⊢
      simp [checkChildren, depthOk, bind, pure, StateT.bind, StateT.pure, result]

theorem candidate_normalization {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate defaultProfile ctx tree = true) :
    normalizeTree ctx (nodesToRaw tree) = .validated tree [] := by
  have result := checkChildren_fixed (2 * rawWeight (nodesToRaw tree) + 1) ctx tree
    .html 0 [] false {} (Nat.le_refl _) (Nat.zero_le _)
    (permits_nodes (candidate_permits h)) (candidate_representation h) rfl
    (by simpa using candidate_node_bound h) (by simpa using candidate_text_bound h)
  simp [normalizeTree, result, addTreeStats]

theorem candidate_reference_fixed_point {ctx : Ctx} {tree : List Node}
    (h : acceptCandidate defaultProfile ctx tree = true) :
    checkTree ctx (nodesToRaw tree) = .validated tree [] := by
  have hp : policyOk ctx tree = true := candidate_permits h
  simp [checkTree, candidate_normalization h, hp]

end Guard.Props
