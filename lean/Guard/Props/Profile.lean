import Guard.Policy.Check
import Guard.Policy.Capabilities
import Guard.Props.Checker
import Guard.Props.Color
import Guard.Props.Ident

/-!
Profile well-formedness, the shipped-profile certificate, and the baseline
exclusion and value contracts.

Three obligations are discharged here:

* `default_profile_valid` -- the shipped profile stays within the reviewed
  capability set and under its hard limits.
* `accepted_no_excluded_attribute`, `accepted_no_excluded_element` and their
  concrete corollaries, plus `accepted_paint_grammar` and
  `accepted_id_is_prefixed` -- every accepted output tree satisfies the
  kernel's exclusions and value contracts. These are not restatements of the
  profile table: `valid_excludes_attr`, `valid_excludes_element` and
  `valid_global_value` hold for *every* profile that certifies, and the
  concrete names come from the reviewed inventory's own consistency condition
  rather than from `rules/policy.json`.
* `restricts_permits` -- if one profile restricts another, every tree the
  first permits as output is permitted by the second.

`restricts_permits` is about permitted *output* trees. It does not say that a
tighter profile accepts fewer raw inputs: a tighter profile may remove more
content from an input and still accept a smaller output.

None of this proves the generator, the inventory itself, the JavaScript
checker, the parser, the renderer or the browser correct.
-/

set_option maxRecDepth 100000

namespace Guard.Props

open V

/-! ## Small list and option facts -/

/-- `List.lookup` returns a pair that really occurs in the list. -/
theorem mem_of_lookup {α β : Type} [BEq α] [LawfulBEq α] {l : List (α × β)} {a : α} {b : β}
    (h : l.lookup a = some b) : (a, b) ∈ l := by
  induction l with
  | nil => simp [List.lookup] at h
  | cons x xs ih =>
    obtain ⟨k, v⟩ := x
    cases hk : a == k with
    | true =>
      have hak : a = k := eq_of_beq hk
      subst hak
      simp only [List.lookup, hk, Option.some.injEq] at h
      subst h
      exact List.mem_cons_self _ _
    | false =>
      simp only [List.lookup, hk] at h
      exact List.mem_cons_of_mem _ (ih h)

theorem eq_none_of_isNone {α : Type} {o : Option α} (h : o.isNone = true) : o = none := by
  cases o with
  | none => rfl
  | some _ => simp at h

theorem mem_allNs (ns : Ns) : ns ∈ allNs := by cases ns <;> simp [allNs]

/-! ## Validator semantics under restriction -/

/-- Rule tags are transparent: they select the rule cited on failure, not the
grammar. -/
theorem apply_core (ctx : Ctx) (v : Val) : Val.apply ctx v = Val.apply ctx v.core := by
  induction v with
  | tagged _ v ih => simpa [Val.apply, Val.core] using ih
  | _ => rfl

theorem oneOf_canonical {vs : List String} {s : String} (h : V.oneOf vs s = some s) :
    vs.contains (V.trim s) = true ∧ V.trim s = s := by
  simp only [V.oneOf] at h
  by_cases hc : vs.contains (V.trim s) = true
  · rw [if_pos hc] at h
    simp only [Option.some.injEq] at h
    exact ⟨hc, h⟩
  · rw [if_neg hc] at h
    simp at h

theorem oneOf_of_contains {vs : List String} {s : String} (hc : vs.contains (V.trim s) = true)
    (ht : V.trim s = s) : V.oneOf vs s = some s := by
  simp only [V.oneOf]
  rw [if_pos hc, ht]

/-- Widening an integer range keeps every canonical value it already accepted. -/
theorem boundedInt_widen {a b lo hi : Int} (hlo : lo ≤ a) (hhi : b ≤ hi) {s : String}
    (h : V.boundedInt a b s = some s) : V.boundedInt lo hi s = some s := by
  unfold V.boundedInt at h ⊢
  cases hp : V.intParse s with
  | none => rw [hp] at h; simp at h
  | some n =>
    rw [hp] at h
    dsimp only at h ⊢
    by_cases hr : (decide (n < a) || decide (n > b)) = true
    · rw [if_pos hr] at h; simp at h
    · rw [if_neg hr] at h
      have hr' : ¬((decide (n < lo) || decide (n > hi)) = true) := by
        simp only [Bool.or_eq_true, decide_eq_true_eq] at hr ⊢
        omega
      rw [if_neg hr']
      exact h

/-- Widening a number-list bound keeps every canonical value it accepted. -/
theorem numberListOf_widen {k m : Nat} (hkm : k ≤ m) {parts : List (List Char)} {r : List Char}
    (h : V.numberListOf k parts = some r) : V.numberListOf m parts = some r := by
  unfold V.numberListOf at h ⊢
  by_cases hg : (parts.isEmpty || decide (parts.length > k)) = true
  · rw [if_pos hg] at h; simp at h
  · have hg' : ¬((parts.isEmpty || decide (parts.length > m)) = true) := by
      simp only [Bool.or_eq_true, decide_eq_true_eq, not_or] at hg ⊢
      exact ⟨hg.1, by have := hg.2; omega⟩
    rw [if_neg hg']
    rw [if_neg hg] at h
    exact h

theorem numberList_widen {k m : Nat} (hkm : k ≤ m) {s : String}
    (h : V.numberList k s = some s) : V.numberList m s = some s := by
  unfold V.numberList V.numberListChars at h ⊢
  cases hk : V.numberListOf k (V.splitRuns true (V.trimChars s.toList)) with
  | none => rw [hk] at h; simp at h
  | some r =>
    rw [hk] at h
    simp only [Option.map_some', Option.some.injEq] at h
    rw [numberListOf_widen hkm hk]
    simp [h]

/--
The restriction relation is sound for values: everything the narrower
descriptor accepts canonically, the wider one accepts canonically too. This is
proved, not assumed, so `Val.restricts` cannot silently permit a grammar swap.
-/
theorem restricts_apply {ctx : Ctx} {v w : Val} (hr : v.restricts w = true) {s : String}
    (hv : v.apply ctx s = some s) : w.apply ctx s = some s := by
  rw [apply_core] at hv
  rw [apply_core]
  unfold Val.restricts at hr
  split at hr
  case h_1 ws vs hvc hwc =>
    rw [hvc] at hv
    rw [hwc]
    simp only [Bool.and_eq_true] at hr
    obtain ⟨hc, ht⟩ := oneOf_canonical hv
    exact oneOf_of_contains (List.all_eq_true.mp hr.2 _ (List.mem_of_elem_eq_true hc)) ht
  case h_2 x vs hvc hwc =>
    rw [hvc] at hv
    rw [hwc]
    simp only [Bool.and_eq_true, beq_iff_eq] at hr
    have hxs : x = s := by simpa [Val.apply, V.fixed] using hv
    subst hxs
    exact oneOf_of_contains (by rw [hr.2]; exact hr.1) hr.2
  case h_3 x y hvc hwc =>
    rw [hvc] at hv
    rw [hwc]
    have hxy : x = y := by simpa using hr
    subst hxy
    exact hv
  case h_4 a b lo hi hvc hwc =>
    rw [hvc] at hv
    rw [hwc]
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hr
    exact boundedInt_widen hr.1.1 hr.2 (by simpa [Val.apply] using hv)
  case h_5 k m hvc hwc =>
    rw [hvc] at hv
    rw [hwc]
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hr
    exact numberList_widen hr.2 (by simpa [Val.apply] using hv)
  case h_6 =>
    have hvw : v.core = w.core := by simpa using hr
    rw [← hvw]
    exact hv

/-! ## Projections out of the decidable profile checks -/

theorem valid_global {c : Capabilities} {p : Profile} (h : profileValid c p = true) (ns : Ns) :
    capGlobalValid c ns (p.globalTable ns) = true := by
  cases hx : capGlobalValid c ns (p.globalTable ns) with
  | false =>
    have hall : (allNs.all fun n => capGlobalValid c n (p.globalTable n) &&
        capElementsValid c p n) = true := by
      cases hy : (allNs.all fun n => capGlobalValid c n (p.globalTable n) &&
          capElementsValid c p n) with
      | false => simp [profileValid, hy] at h
      | true => rfl
    have := List.all_eq_true.mp hall ns (mem_allNs ns)
    simp [hx] at this
  | true => rfl

theorem valid_elements {c : Capabilities} {p : Profile} (h : profileValid c p = true) (ns : Ns) :
    capElementsValid c p ns = true := by
  cases hx : capElementsValid c p ns with
  | false =>
    have hall : (allNs.all fun n => capGlobalValid c n (p.globalTable n) &&
        capElementsValid c p n) = true := by
      cases hy : (allNs.all fun n => capGlobalValid c n (p.globalTable n) &&
          capElementsValid c p n) with
      | false => simp [profileValid, hy] at h
      | true => rfl
    have := List.all_eq_true.mp hall ns (mem_allNs ns)
    simp [hx] at this
  | true => rfl

theorem valid_limits {c : Capabilities} {p : Profile} (h : profileValid c p = true) :
    p.limits.within c.ceilings = true := by
  cases hx : p.limits.within c.ceilings with
  | false => simp [profileValid, hx] at h
  | true => rfl

theorem valid_forced {c : Capabilities} {p : Profile} (h : profileValid c p = true) :
    capForcedKept c p = true := by
  cases hx : capForcedKept c p with
  | false => simp [profileValid, hx] at h
  | true => rfl

theorem valid_required {c : Capabilities} {p : Profile} (h : profileValid c p = true) :
    capRequiredKept c p = true := by
  cases hx : capRequiredKept c p with
  | false => simp [profileValid, hx] at h
  | true => rfl

theorem valid_text_only {c : Capabilities} {p : Profile} (h : profileValid c p = true) :
    capTextOnlyKept c p = true := by
  cases hx : capTextOnlyKept c p with
  | false => simp [profileValid, hx] at h
  | true => rfl

theorem consistent_excluded_attr {c : Capabilities} (h : capsConsistent c = true) {name : String}
    (hex : name ∈ c.excludedAttrs) : capAttrAbsent c name = true := by
  have hall : c.excludedAttrs.all (capAttrAbsent c) = true := by
    cases hy : c.excludedAttrs.all (capAttrAbsent c) with
    | false => simp [capsConsistent, hy] at h
    | true => rfl
  exact List.all_eq_true.mp hall name hex

theorem consistent_excluded_element {c : Capabilities} (h : capsConsistent c = true) {ns : Ns}
    {tag : String} (hex : tag ∈ c.excludedElements ns) : c.elementTable ns tag = none := by
  have hall : (c.excludedElements ns).all (fun t => (c.elementTable ns t).isNone) = true := by
    cases ns
    · cases hy : c.excludedHtmlElements.all (fun t => (c.elementTable Ns.html t).isNone) with
      | false => simp [capsConsistent, hy] at h
      | true => simpa [Capabilities.excludedElements] using hy
    · cases hy : c.excludedSvgElements.all (fun t => (c.elementTable Ns.svg t).isNone) with
      | false => simp [capsConsistent, hy] at h
      | true => simpa [Capabilities.excludedElements] using hy
  exact eq_none_of_isNone (List.all_eq_true.mp hall tag hex)

theorem consistent_no_shadow {c : Capabilities} (h : capsConsistent c = true) :
    capNoShadow c = true := by
  cases hx : capNoShadow c with
  | false => simp [capsConsistent, hx] at h
  | true => rfl

/-! ## Absent attribute identities -/

theorem absent_shared {c : Capabilities} {name : String} (h : capAttrAbsent c name = true) :
    c.sharedAttrs.lookup name = none := by
  cases hx : (c.sharedAttrs.lookup name).isNone with
  | false => simp [capAttrAbsent, hx] at h
  | true => exact eq_none_of_isNone hx

theorem absent_ns {c : Capabilities} {name : String} (h : capAttrAbsent c name = true) (ns : Ns) :
    ((c.globalTable ns).lookup name).isNone = true ∧
      (c.elements ns).all (fun e => (e.2.lookup name).isNone) = true := by
  have hall : (allNs.all fun n => ((c.globalTable n).lookup name).isNone &&
      (c.elements n).all (fun e => (e.2.lookup name).isNone)) = true := by
    cases hy : (allNs.all fun n => ((c.globalTable n).lookup name).isNone &&
        (c.elements n).all (fun e => (e.2.lookup name).isNone)) with
    | false => simp [capAttrAbsent, hy] at h
    | true => rfl
  have := List.all_eq_true.mp hall ns (mem_allNs ns)
  simpa [Bool.and_eq_true] using this

/-! ## What a certified profile can permit -/

theorem attrFor_mem {p : Profile} {ns : Ns} {table : Table} {name : String} {v : Val}
    (h : p.attrFor ns table name = some v) : (name, v) ∈ table ++ p.globalTable ns := by
  unfold Profile.attrFor at h
  cases ht : table.lookup name with
  | some v' =>
    rw [ht] at h
    have hvv : v' = v := by
      simp only [Option.orElse, Option.some.injEq] at h
      exact h
    subst hvv
    exact List.mem_append_left _ (mem_of_lookup ht)
  | none =>
    rw [ht] at h
    simp only [Option.orElse] at h
    exact List.mem_append_right _ (mem_of_lookup h)

/-- A certified profile permits no element outside the reviewed inventory. -/
theorem valid_element_within {c : Capabilities} {p : Profile} (h : profileValid c p = true)
    {ns : Ns} {tag : String} {table : Table} (hel : p.elementTable ns tag = some table) :
    ∃ capTable, c.elementTable ns tag = some capTable ∧
      capTableValid c p ns table capTable = true := by
  have hv := valid_elements h ns
  have hentry := List.all_eq_true.mp hv (tag, table)
    (mem_of_lookup (by simpa [Profile.elementTable] using hel))
  cases hc : c.elementTable ns tag with
  | none => rw [hc] at hentry; simp at hentry
  | some capTable =>
    refine ⟨capTable, rfl, ?_⟩
    rw [hc] at hentry
    simpa using hentry

/-- A certified profile uses, for every attribute it resolves, a grammar that
restricts the reviewed grammar for that attribute in that context. -/
theorem valid_attr_within {c : Capabilities} {p : Profile} (h : profileValid c p = true)
    {ns : Ns} {tag name : String} {table : Table} {v : Val}
    (hel : p.elementTable ns tag = some table) (ha : p.attrFor ns table name = some v) :
    ∃ capTable w, c.elementTable ns tag = some capTable ∧
      c.attrFor ns capTable name = some w ∧ v.restricts w = true := by
  obtain ⟨capTable, hc, hvalid⟩ := valid_element_within h hel
  have hentry := List.all_eq_true.mp hvalid (name, v) (attrFor_mem ha)
  rw [ha] at hentry
  cases hw : c.attrFor ns capTable name with
  | none => rw [hw] at hentry; simp at hentry
  | some w =>
    refine ⟨capTable, w, hc, hw, ?_⟩
    rw [hw] at hentry
    simpa using hentry

/-- Excluded attribute identities are unreachable for every certified profile,
in every element context. -/
theorem valid_excludes_attr {c : Capabilities} {p : Profile} (hcc : capsConsistent c = true)
    (h : profileValid c p = true) {name : String} (hex : name ∈ c.excludedAttrs)
    {ns : Ns} {tag : String} {table : Table} (hel : p.elementTable ns tag = some table) :
    p.attrFor ns table name = none := by
  cases ha : p.attrFor ns table name with
  | none => rfl
  | some v =>
    exfalso
    obtain ⟨capTable, w, hc, hw, _⟩ := valid_attr_within h hel ha
    have habs := consistent_excluded_attr hcc hex
    obtain ⟨hglobNone, hallEls⟩ := absent_ns habs ns
    have hcap : capTable.lookup name = none :=
      eq_none_of_isNone (List.all_eq_true.mp hallEls (tag, capTable) (mem_of_lookup hc))
    rw [Capabilities.attrFor, Capabilities.globalOrShared, hcap,
      eq_none_of_isNone hglobNone, absent_shared habs] at hw
    simp [Option.orElse] at hw

/-- Excluded element identities are unreachable for every certified profile. -/
theorem valid_excludes_element {c : Capabilities} {p : Profile} (hcc : capsConsistent c = true)
    (h : profileValid c p = true) {ns : Ns} {tag : String} (hex : tag ∈ c.excludedElements ns) :
    p.elementTable ns tag = none := by
  cases hel : p.elementTable ns tag with
  | none => rfl
  | some table =>
    exfalso
    obtain ⟨capTable, hc, _⟩ := valid_element_within h hel
    rw [consistent_excluded_element hcc hex] at hc
    cases hc

/-- The inventory grammar for a namespace-global or shared attribute is the
same in every element context, because the inventory never shadows it. -/
theorem cap_global_grammar {c : Capabilities} (hcc : capsConsistent c = true) {ns : Ns}
    {tag name : String} {capTable : Table} {w : Val}
    (hel : c.elementTable ns tag = some capTable)
    (hg : c.globalOrShared ns name = some w) : c.attrFor ns capTable name = some w := by
  have hshadow := List.all_eq_true.mp (consistent_no_shadow hcc) ns (mem_allNs ns)
  have hmem : (name, w) ∈ (c.globalTable ns) ++ c.sharedAttrs := by
    unfold Capabilities.globalOrShared at hg
    cases ht : (c.globalTable ns).lookup name with
    | some w' =>
      rw [ht] at hg
      have hww : w' = w := by
        simp only [Option.orElse, Option.some.injEq] at hg
        exact hg
      subst hww
      exact List.mem_append_left _ (mem_of_lookup ht)
    | none =>
      rw [ht] at hg
      simp only [Option.orElse] at hg
      exact List.mem_append_right _ (mem_of_lookup hg)
  have hall := List.all_eq_true.mp hshadow (name, w) hmem
  have hnone : capTable.lookup name = none :=
    eq_none_of_isNone (List.all_eq_true.mp hall (tag, capTable) (mem_of_lookup hel))
  rw [Capabilities.attrFor, hnone]
  simpa [Option.orElse] using hg

/-- Value contract for a global attribute: whatever a certified profile emits
for it also satisfies the reviewed kernel grammar. -/
theorem valid_global_value {c : Capabilities} {p : Profile} (hcc : capsConsistent c = true)
    (h : profileValid c p = true) {ctx : Ctx} {ns : Ns} {tag name value : String}
    {table : Table} {v w : Val}
    (hel : p.elementTable ns tag = some table) (ha : p.attrFor ns table name = some v)
    (hv : v.apply ctx value = some value) (hg : c.globalOrShared ns name = some w) :
    w.apply ctx value = some value := by
  obtain ⟨capTable, w', hc, hcw, hres⟩ := valid_attr_within h hel ha
  have hsame : some w' = some w := by rw [← hcw]; exact cap_global_grammar hcc hc hg
  injection hsame with hww
  subst hww
  exact restricts_apply hres hv

/-! ## The shipped profile's certificate

`decide` evaluates the checks on the concrete inventory and profile, so a
widened profile or a stale generated inventory fails here at build time. -/

theorem caps_consistent : capsConsistent caps = true := by decide

theorem default_profile_valid : profileValid caps defaultProfile = true := by decide

/-! ## Baseline exclusions for accepted output -/

theorem accepted_no_excluded_element {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {ns : Ns} {tag : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el ns tag attrs children) tree) : tag ∉ caps.excludedElements ns := by
  intro hex
  obtain ⟨table, hel, _⟩ := accepted_element_allowed h occurs
  rw [valid_excludes_element caps_consistent default_profile_valid hex] at hel
  cases hel

theorem accepted_no_excluded_attribute {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {ns : Ns} {tag name value : String}
    {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el ns tag attrs children) tree) (member : (name, value) ∈ attrs) :
    name ∉ caps.excludedAttrs := by
  intro hex
  obtain ⟨table, v, hel, ha, _⟩ := accepted_attribute_validator h occurs member
  rw [valid_excludes_attr caps_consistent default_profile_valid hex hel] at ha
  cases ha

/-- Concrete resource, style and clobbering attribute names, taken from the
reviewed exclusions rather than from the profile table. -/
theorem accepted_no_resource_attribute {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {ns : Ns} {tag name value : String}
    {attrs : List (String × String)} {children : List Node}
    (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el ns tag attrs children) tree) (member : (name, value) ∈ attrs) :
    name ≠ "src" ∧ name ≠ "srcset" ∧ name ≠ "href" ∧ name ≠ "poster" ∧ name ≠ "action" ∧
      name ≠ "formaction" ∧ name ≠ "background" ∧ name ≠ "style" ∧ name ≠ "name" ∧
      name ≠ "__proto__" ∧ name ≠ "constructor" ∧ name ≠ "prototype" ∧ name ≠ "autofocus" ∧
      name ≠ "filter" ∧ name ≠ "mask" ∧ name ≠ "clip-path" := by
  have hx := accepted_no_excluded_attribute h occurs member
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;>
    intro he <;> subst he <;> exact hx (by decide)

theorem accepted_no_active_html_element {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {tag : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el .html tag attrs children) tree) :
    tag ≠ "script" ∧ tag ≠ "style" ∧ tag ≠ "iframe" ∧ tag ≠ "object" ∧ tag ≠ "embed" ∧
      tag ≠ "img" ∧ tag ≠ "link" ∧ tag ≠ "meta" ∧ tag ≠ "base" ∧ tag ≠ "form" ∧ tag ≠ "a" ∧
      tag ≠ "template" ∧ tag ≠ "video" ∧ tag ≠ "audio" ∧ tag ≠ "math" ∧ tag ≠ "svg" := by
  have hx := accepted_no_excluded_element h occurs
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;>
    intro he <;> subst he <;> exact hx (by decide)

theorem accepted_no_active_svg_element {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {tag : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el .svg tag attrs children) tree) :
    tag ≠ "script" ∧ tag ≠ "style" ∧ tag ≠ "image" ∧ tag ≠ "use" ∧ tag ≠ "foreignobject" ∧
      tag ≠ "animate" ∧ tag ≠ "set" ∧ tag ≠ "pattern" ∧ tag ≠ "filter" ∧ tag ≠ "mask" ∧
      tag ≠ "marker" ∧ tag ≠ "clippath" ∧ tag ≠ "lineargradient" ∧ tag ≠ "radialgradient" ∧
      tag ≠ "textpath" ∧ tag ≠ "a" := by
  have hx := accepted_no_excluded_element h occurs
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;>
    intro he <;> subst he <;> exact hx (by decide)

/-! ## Baseline value contracts for accepted output -/

/-- Accepted SVG paint satisfies the reviewed solid-color grammar, whatever
validator the profile selected for `fill`/`stroke`. -/
theorem accepted_paint_is_solid_color {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {tag name value : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el .svg tag attrs children) tree) (member : (name, value) ∈ attrs)
    (hname : name = "fill" ∨ name = "stroke") : V.color value = some value := by
  obtain ⟨table, v, hel, ha, hv⟩ := accepted_attribute_validator h occurs member
  have hg : caps.globalOrShared Ns.svg name = some Val.color := by
    rcases hname with rfl | rfl <;> rfl
  have hres := valid_global_value caps_consistent default_profile_valid hel ha hv hg
  simpa [Val.apply] using hres

/-- Consequently accepted paint is a named color, `currentColor`, a hex color
or an `rgb()` form -- never a `url(...)` resource reference. -/
theorem accepted_paint_grammar {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {tag name value : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el .svg tag attrs children) tree) (member : (name, value) ∈ attrs)
    (hname : name = "fill" ∨ name = "stroke") :
    namedColors.contains value = true ∨ value.toList = "currentColor".toList ∨
      (∃ hs, value.toList = '#' :: hs ∧ hs.all isHex = true) ∨ rgbOk value.toList = true := by
  have hc := accepted_paint_is_solid_color h occurs member hname
  unfold V.color at hc
  cases hcc : colorChars value.toList with
  | none => rw [hcc] at hc; simp at hc
  | some r =>
    rw [hcc] at hc
    simp only [Option.map_some', Option.some.injEq] at hc
    have hr : r = value.toList := by rw [← hc]; rfl
    subst hr
    exact colorChars_ok hcc

/-- Accepted ids carry the `g-` prefix, so generated ids cannot shadow host or
frame identifiers. -/
theorem accepted_id_is_prefixed {ctx : Ctx} {raws : List Raw} {tree : List Node}
    {changes : List Change} {ns : Ns} {tag value : String} {attrs : List (String × String)}
    {children : List Node} (h : checkTree ctx raws = .validated tree changes)
    (occurs : InTree (.el ns tag attrs children) tree) (member : ("id", value) ∈ attrs) :
    ∃ rest, value.toList = 'g' :: '-' :: rest := by
  obtain ⟨table, v, hel, ha, hv⟩ := accepted_attribute_validator h occurs member
  have hg : caps.globalOrShared ns "id" = some Val.id := by cases ns <;> rfl
  have hid : V.idValue value = some value := by
    simpa [Val.apply] using valid_global_value caps_consistent default_profile_valid hel ha hv hg
  unfold V.idValue at hid
  cases hc : idValueChars (trimChars value.toList) with
  | none => rw [hc] at hid; simp at hid
  | some r =>
    rw [hc] at hid
    simp only [Option.map_some', Option.some.injEq] at hid
    obtain ⟨rest, hrest⟩ := idValueChars_prefixed _ _ hc
    refine ⟨rest, ?_⟩
    rw [← hid, ← hrest]
    rfl

/-! ## Profile restriction on permitted output trees

`profileRestricts p2 p1` implies that every tree `p2` permits as output, `p1`
permits as output. This is a statement about permitted output trees only: it
does *not* say that a tighter profile accepts fewer raw inputs, because a
tighter profile removes more content and can still accept a smaller output. -/

theorem within_maxNodes {l c : Limits} (h : l.within c = true) : l.maxNodes ≤ c.maxNodes := by
  by_cases hx : l.maxNodes ≤ c.maxNodes
  · exact hx
  · simp [Limits.within, hx] at h

theorem within_maxDepth {l c : Limits} (h : l.within c = true) : l.maxDepth ≤ c.maxDepth := by
  by_cases hx : l.maxDepth ≤ c.maxDepth
  · exact hx
  · simp [Limits.within, hx] at h

theorem within_maxTextLength {l c : Limits} (h : l.within c = true) :
    l.maxTextLength ≤ c.maxTextLength := by
  by_cases hx : l.maxTextLength ≤ c.maxTextLength
  · exact hx
  · simp [Limits.within, hx] at h

theorem within_maxTotalText {l c : Limits} (h : l.within c = true) :
    l.maxTotalText ≤ c.maxTotalText := by
  by_cases hx : l.maxTotalText ≤ c.maxTotalText
  · exact hx
  · simp [Limits.within, hx] at h

theorem within_maxAttrs {l c : Limits} (h : l.within c = true) : l.maxAttrs ≤ c.maxAttrs := by
  by_cases hx : l.maxAttrs ≤ c.maxAttrs
  · exact hx
  · simp [Limits.within, hx] at h

theorem restricts_limits {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) :
    p2.limits.within p1.limits = true := by
  cases hx : p2.limits.within p1.limits with
  | false => simp [profileRestricts, hx] at hr
  | true => rfl

theorem restricts_element {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) {ns : Ns}
    {tag : String} {t2 : Table} (hel : p2.elementTable ns tag = some t2) :
    ∃ t1, p1.elementTable ns tag = some t1 ∧ tableRestricts p2 p1 ns t2 t1 = true := by
  have hall : allNs.all (elementsRestrict p2 p1) = true := by
    cases hy : allNs.all (elementsRestrict p2 p1) with
    | false => simp [profileRestricts, hy] at hr
    | true => rfl
  have hns := List.all_eq_true.mp hall ns (mem_allNs ns)
  have hentry := List.all_eq_true.mp hns (tag, t2)
    (mem_of_lookup (by simpa [Profile.elementTable] using hel))
  cases h1 : p1.elementTable ns tag with
  | none => rw [h1] at hentry; simp at hentry
  | some t1 =>
    refine ⟨t1, rfl, ?_⟩
    rw [h1] at hentry
    simpa using hentry

theorem restricts_textOnly {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) {tag : String}
    (hel : (p2.elementTable Ns.svg tag).isSome = true) (h1 : p1.svgTextOnly.contains tag = true) :
    p2.svgTextOnly.contains tag = true := by
  have hall : textOnlyRestricts p2 p1 = true := by
    cases hy : textOnlyRestricts p2 p1 with
    | false => simp [profileRestricts, hy] at hr
    | true => rfl
  have hentry := List.all_eq_true.mp hall tag (List.mem_of_elem_eq_true h1)
  simp only [Bool.or_eq_true] at hentry
  rcases hentry with hnone | hyes
  · cases hx : p2.elementTable Ns.svg tag with
    | none => rw [hx] at hel; simp at hel
    | some _ => rw [hx] at hnone; simp at hnone
  · exact hyes

theorem restricts_forced {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) {tag : String}
    {pairs : List (String × String)} (hel : (p2.elementTable Ns.html tag).isSome = true)
    (hp1 : p1.htmlForced.lookup tag = some pairs) :
    pairs.all (fun q => (((p2.htmlForced.lookup tag).getD []).lookup q.1) == some q.2) = true := by
  have hall : forcedRestricts p2 p1 = true := by
    cases hy : forcedRestricts p2 p1 with
    | false => simp [profileRestricts, hy] at hr
    | true => rfl
  have hentry := List.all_eq_true.mp hall (tag, pairs) (mem_of_lookup hp1)
  cases hx : p2.elementTable Ns.html tag with
  | none => rw [hx] at hel; simp at hel
  | some _ => rw [hx] at hentry; simpa using hentry

/-! ### Attribute canonicality under restriction -/

theorem attrCanonical_restricts {p2 p1 : Profile} {ctx : Ctx} {ns : Ns} {t2 t1 : Table}
    (htab : tableRestricts p2 p1 ns t2 t1 = true) {name value : String}
    (h : attrCanonical p2 ctx ns t2 (name, value) = true) :
    attrCanonical p1 ctx ns t1 (name, value) = true := by
  obtain ⟨hcolon, hon⟩ := attribute_has_no_handler_or_prefix h
  obtain ⟨v, hfound, happly⟩ := attribute_validator h
  have hentry := List.all_eq_true.mp htab (name, v) (attrFor_mem hfound)
  rw [hfound] at hentry
  cases hw : p1.attrFor ns t1 name with
  | none => rw [hw] at hentry; simp at hentry
  | some w =>
    rw [hw] at hentry
    have hres : v.restricts w = true := by simpa using hentry
    simp [attrCanonical, hcolon, hon, hw, restricts_apply hres happly]

theorem attrsCanonical_len {prof : Profile} {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {attrs : List (String × String)} (h : attrsCanonical prof ctx ns tag table attrs = true) :
    attrs.length ≤ prof.limits.maxAttrs := by
  by_cases hx : attrs.length ≤ prof.limits.maxAttrs
  · exact hx
  · simp [attrsCanonical, hx] at h

theorem attrsCanonical_all {prof : Profile} {ctx : Ctx} {ns : Ns} {tag : String} {table : Table}
    {attrs : List (String × String)} (h : attrsCanonical prof ctx ns tag table attrs = true) :
    attrs.all (attrCanonical prof ctx ns table) = true := by
  cases hx : attrs.all (attrCanonical prof ctx ns table) with
  | false => simp [attrsCanonical, hx] at h
  | true => rfl

theorem attrsCanonical_forced {prof : Profile} {ctx : Ctx} {tag : String} {table : Table}
    {attrs : List (String × String)}
    (h : attrsCanonical prof ctx Ns.html tag table attrs = true) :
    ((prof.htmlForced.lookup tag).getD []).all (fun q => attrs.lookup q.1 == some q.2) = true := by
  cases hx : ((prof.htmlForced.lookup tag).getD []).all (fun q => attrs.lookup q.1 == some q.2) with
  | false =>
    unfold attrsCanonical at h
    rw [if_pos (show ((Ns.html == Ns.html) = true) from rfl), hx] at h
    simp at h
  | true => rfl

theorem attrsCanonical_inputType {prof : Profile} {ctx : Ctx} {tag : String} {table : Table}
    {attrs : List (String × String)}
    (h : attrsCanonical prof ctx Ns.html tag table attrs = true) :
    (tag != "input" || (attrs.lookup "type").isSome) = true := by
  cases hx : (tag != "input" || (attrs.lookup "type").isSome) with
  | false =>
    unfold attrsCanonical at h
    rw [if_pos (show ((Ns.html == Ns.html) = true) from rfl), hx] at h
    simp at h
  | true => rfl

theorem attrsCanonical_svg_mk {prof : Profile} {ctx : Ctx} {tag : String} {table : Table}
    {attrs : List (String × String)} (hlen : attrs.length ≤ prof.limits.maxAttrs)
    (hall : attrs.all (attrCanonical prof ctx Ns.svg table) = true) :
    attrsCanonical prof ctx Ns.svg tag table attrs = true := by
  unfold attrsCanonical
  rw [if_neg (show ¬((Ns.svg == Ns.html) = true) by decide)]
  simp only [hall, Bool.and_true, Bool.true_and, decide_eq_true_eq]
  exact hlen

theorem attrsCanonical_html_mk {prof : Profile} {ctx : Ctx} {tag : String} {table : Table}
    {attrs : List (String × String)} (hlen : attrs.length ≤ prof.limits.maxAttrs)
    (hall : attrs.all (attrCanonical prof ctx Ns.html table) = true)
    (hforced : ((prof.htmlForced.lookup tag).getD []).all
      (fun q => attrs.lookup q.1 == some q.2) = true)
    (htype : (tag != "input" || (attrs.lookup "type").isSome) = true) :
    attrsCanonical prof ctx Ns.html tag table attrs = true := by
  unfold attrsCanonical
  rw [if_pos (show ((Ns.html == Ns.html) = true) from rfl)]
  simp only [hall, hforced, htype, Bool.and_true, Bool.true_and, decide_eq_true_eq]
  exact hlen

theorem attrsCanonical_restricts {p2 p1 : Profile} {ctx : Ctx} {ns : Ns} {tag : String}
    {t2 t1 : Table} {attrs : List (String × String)} (hr : profileRestricts p2 p1 = true)
    (htab : tableRestricts p2 p1 ns t2 t1 = true)
    (hel : (p2.elementTable ns tag).isSome = true)
    (h : attrsCanonical p2 ctx ns tag t2 attrs = true) :
    attrsCanonical p1 ctx ns tag t1 attrs = true := by
  have hlen : attrs.length ≤ p1.limits.maxAttrs :=
    Nat.le_trans (attrsCanonical_len h) (within_maxAttrs (restricts_limits hr))
  have hall : attrs.all (attrCanonical p1 ctx ns t1) = true := by
    refine List.all_eq_true.mpr fun pair hmem => ?_
    obtain ⟨n, v⟩ := pair
    exact attrCanonical_restricts htab (List.all_eq_true.mp (attrsCanonical_all h) (n, v) hmem)
  cases ns with
  | svg => exact attrsCanonical_svg_mk hlen hall
  | html =>
    refine attrsCanonical_html_mk hlen hall ?_ (attrsCanonical_inputType h)
    -- every control attribute p1 forces is forced by p2, hence present
    have hp2forced := attrsCanonical_forced h
    cases hp1 : p1.htmlForced.lookup tag with
    | none => rfl
    | some pairs =>
      show (pairs.all fun q => attrs.lookup q.1 == some q.2) = true
      refine List.all_eq_true.mpr fun q hq => ?_
      have hkeep := List.all_eq_true.mp (restricts_forced hr hel hp1) q hq
      have hmem2 : (q.1, q.2) ∈ (p2.htmlForced.lookup tag).getD [] :=
        mem_of_lookup (by simpa using hkeep)
      simpa using List.all_eq_true.mp hp2forced (q.1, q.2) hmem2

/-! ### Node predicate destructors and constructors -/

theorem text_nonempty {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {s : String} (h : nodePolicyOk prof ctx parent depth textOnly (.text s) = true) :
    (!s.isEmpty) = true := by
  cases hx : (!s.isEmpty) with
  | false => simp [nodePolicyOk, hx] at h
  | true => rfl

theorem text_clean {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {s : String} (h : nodePolicyOk prof ctx parent depth textOnly (.text s) = true) :
    (cleanText s == s) = true := by
  cases hx : (cleanText s == s) with
  | false => simp [nodePolicyOk, hx] at h
  | true => rfl

theorem text_len {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {s : String} (h : nodePolicyOk prof ctx parent depth textOnly (.text s) = true) :
    utf16Length s ≤ prof.limits.maxTextLength := by
  by_cases hx : utf16Length s ≤ prof.limits.maxTextLength
  · exact hx
  · simp [nodePolicyOk, hx] at h

theorem text_mk {prof : Profile} {ctx : Ctx} {parent : Ns} {depth : Nat} {textOnly : Bool}
    {s : String} (h1 : (!s.isEmpty) = true) (h2 : (cleanText s == s) = true)
    (h3 : utf16Length s ≤ prof.limits.maxTextLength) :
    nodePolicyOk prof ctx parent depth textOnly (.text s) = true := by
  simp [nodePolicyOk, h1, h2, h3]

theorem el_textOnly {prof : Profile} {ctx : Ctx} {parent ns : Ns} {depth : Nat} {textOnly : Bool}
    {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : nodePolicyOk prof ctx parent depth textOnly (.el ns tag attrs children) = true) :
    textOnly = false := by
  cases hx : textOnly with
  | false => rfl
  | true => simp [nodePolicyOk, hx] at h

theorem el_depth {prof : Profile} {ctx : Ctx} {parent ns : Ns} {depth : Nat} {textOnly : Bool}
    {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : nodePolicyOk prof ctx parent depth textOnly (.el ns tag attrs children) = true) :
    depth + 1 ≤ prof.limits.maxDepth := by
  by_cases hx : depth + 1 ≤ prof.limits.maxDepth
  · exact hx
  · simp [nodePolicyOk, hx] at h

theorem el_nsOk {prof : Profile} {ctx : Ctx} {parent ns : Ns} {depth : Nat} {textOnly : Bool}
    {tag : String} {attrs : List (String × String)} {children : List Node}
    (h : nodePolicyOk prof ctx parent depth textOnly (.el ns tag attrs children) = true) :
    (if ns == .html then parent == .html else tag == "svg" || parent == .svg) = true := by
  cases hx : (if ns == .html then parent == Ns.html else tag == "svg" || parent == Ns.svg) with
  | false => simp [nodePolicyOk, hx] at h
  | true => rfl

theorem el_mk {prof : Profile} {ctx : Ctx} {parent ns : Ns} {depth : Nat}
    {tag : String} {attrs : List (String × String)} {children : List Node} {table : Table}
    (h1 : depth + 1 ≤ prof.limits.maxDepth)
    (h2 : (if ns == .html then parent == .html else tag == "svg" || parent == .svg) = true)
    (h3 : prof.elementTable ns tag = some table)
    (h4 : attrsCanonical prof ctx ns tag table attrs = true)
    (h5 : nodesPolicyOk prof ctx ns (depth + 1)
      (ns == .svg && prof.svgTextOnly.contains tag) children = true) :
    nodePolicyOk prof ctx parent depth false (.el ns tag attrs children) = true := by
  unfold nodePolicyOk
  simp only [Bool.not_false, h2, h3, h4, h5, Bool.true_and, Bool.and_true, decide_eq_true_eq]
  exact h1

/-! ### The induction -/

mutual
def nodeSize : Node → Nat
  | .text _ => 1
  | .el _ _ _ cs => 1 + nodesSize cs

def nodesSize : List Node → Nat
  | [] => 0
  | n :: ns => nodeSize n + nodesSize ns
end

theorem nodeSize_pos (n : Node) : 1 ≤ nodeSize n := by
  cases n with
  | text _ => simp [nodeSize]
  | el _ _ _ cs => simp only [nodeSize]; omega

theorem nodes_restricts {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) :
    ∀ (fuel : Nat) (ctx : Ctx) (parent : Ns) (depth : Nat) (t2 t1 : Bool) (nodes : List Node),
      (t1 = true → t2 = true) → nodesSize nodes ≤ fuel →
      nodesPolicyOk p2 ctx parent depth t2 nodes = true →
      nodesPolicyOk p1 ctx parent depth t1 nodes = true := by
  intro fuel
  induction fuel with
  | zero =>
    intro ctx parent depth t2 t1 nodes himp hsize h
    cases nodes with
    | nil => rfl
    | cons n ns =>
      have hp := nodeSize_pos n
      simp only [nodesSize] at hsize
      omega
  | succ fuel ih =>
    intro ctx parent depth t2 t1 nodes himp hsize h
    cases nodes with
    | nil => rfl
    | cons n ns =>
      simp only [nodesPolicyOk, Bool.and_eq_true] at h ⊢
      have hsz : nodeSize n + nodesSize ns ≤ fuel + 1 := by
        simpa only [nodesSize] using hsize
      have hpos := nodeSize_pos n
      refine ⟨?_, ih ctx parent depth t2 t1 ns himp (by omega) h.2⟩
      cases n with
      | text s =>
        exact text_mk (text_nonempty h.1) (text_clean h.1)
          (Nat.le_trans (text_len h.1) (within_maxTextLength (restricts_limits hr)))
      | el ns' tag attrs children =>
        have ht2 : t2 = false := el_textOnly h.1
        have ht1 : t1 = false := by
          cases hx : t1 with
          | false => rfl
          | true =>
            rw [ht2] at himp
            exact absurd (himp hx) (by simp)
        subst ht1
        obtain ⟨t2table, hel2, hattrs2, hkids2⟩ := allowed_element h.1
        obtain ⟨t1table, hel1, htab⟩ := restricts_element hr hel2
        have hchildren : nodesPolicyOk p1 ctx ns' (depth + 1)
            (ns' == .svg && p1.svgTextOnly.contains tag) children = true := by
          refine ih ctx ns' (depth + 1) (ns' == .svg && p2.svgTextOnly.contains tag)
            (ns' == .svg && p1.svgTextOnly.contains tag) children ?_ ?_ hkids2
          · intro hflag
            simp only [Bool.and_eq_true] at hflag
            have hsvg : ns' = Ns.svg := by
              have hone := hflag.1
              cases ns' with
              | html => exact absurd hone (by decide)
              | svg => rfl
            subst hsvg
            have hkeep := restricts_textOnly hr (by rw [hel2]; rfl) hflag.2
            simp only [Bool.and_eq_true]
            exact ⟨rfl, hkeep⟩
          · simp only [nodeSize] at hsz
            omega
        exact el_mk (Nat.le_trans (el_depth h.1) (within_maxDepth (restricts_limits hr)))
          (el_nsOk h.1) hel1
          (attrsCanonical_restricts hr htab (by rw [hel2]; rfl) hattrs2) hchildren

theorem permits_nodes {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : prof.permits ctx tree = true) : nodesPolicyOk prof ctx .html 0 false tree = true := by
  cases hx : nodesPolicyOk prof ctx Ns.html 0 false tree with
  | false => simp [Profile.permits, hx] at h
  | true => rfl

theorem permits_nodeBound {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : prof.permits ctx tree = true) : (treeStats tree).1 ≤ prof.limits.maxNodes := by
  by_cases hx : (treeStats tree).1 ≤ prof.limits.maxNodes
  · exact hx
  · simp [Profile.permits, hx] at h

theorem permits_textBound {prof : Profile} {ctx : Ctx} {tree : List Node}
    (h : prof.permits ctx tree = true) : (treeStats tree).2 ≤ prof.limits.maxTotalText := by
  by_cases hx : (treeStats tree).2 ≤ prof.limits.maxTotalText
  · exact hx
  · simp [Profile.permits, hx] at h

/--
If `p2` restricts `p1`, every output tree `p2` permits is permitted by `p1`.

Read this as a statement about output trees. It does not claim that tightening
a sanitizer monotonically reduces the raw inputs it accepts: a tighter profile
can remove more content from an input and still accept a smaller output.
-/
theorem restricts_permits {p2 p1 : Profile} (hr : profileRestricts p2 p1 = true) {ctx : Ctx}
    {tree : List Node} (h : p2.permits ctx tree = true) : p1.permits ctx tree = true := by
  have hnodes := nodes_restricts hr (nodesSize tree) ctx .html 0 false false tree
    (fun x => x) (Nat.le_refl _) (permits_nodes h)
  have hn := Nat.le_trans (permits_nodeBound h) (within_maxNodes (restricts_limits hr))
  have ht := Nat.le_trans (permits_textBound h) (within_maxTotalText (restricts_limits hr))
  unfold Profile.permits
  simp only [hnodes, Bool.true_and, decide_eq_true_eq, Bool.and_eq_true]
  exact ⟨hn, ht⟩

end Guard.Props
