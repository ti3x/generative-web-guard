import Guard.Props.Number
import Guard.Validators.Transform

/-!
Transforms: the output is a space-joined list of groups, each `name(nums)`
with a known name and number-list characters inside. Rule: R-VAL-TRANSFORM.
-/

namespace Guard.Props

open V

def groupOk (g : List Char) : Prop :=
  ∃ name nums, g = name ++ '(' :: nums ++ [')'] ∧
    (transformNames.lookup (String.mk name)).isSome = true ∧
    ∀ c ∈ nums, numberListCharOk c = true

theorem transformGroup_ok {cs g rest : List Char} (h : transformGroup cs = some (g, rest)) : groupOk g := by
  unfold transformGroup at h
  simp only at h
  split at h
  · simp at h
  · split at h
    · split at h
      · split at h
        · simp at h
        · split at h
          · simp at h
          · simp only [Option.some.injEq, Prod.mk.injEq] at h
            obtain ⟨hg, -⟩ := h
            subst hg
            refine ⟨_, _, rfl, ?_, numberListChars_ok (by assumption)⟩
            exact Option.isSome_iff_exists.mpr ⟨_, by assumption⟩
      · simp at h
    · simp at h

theorem transformParts_ok : ∀ (fuel : Nat) (cs : List Char) (acc out : List (List Char)),
    transformParts fuel cs acc = some out → (∀ g ∈ acc, groupOk g) → ∀ g ∈ out, groupOk g
  | 0, cs, acc, out, h, hacc => by
    simp only [transformParts] at h
    split at h
    · simp only [Option.some.injEq] at h; subst h
      intro g hg; exact hacc g (List.mem_reverse.mp hg)
    · simp at h
  | fuel + 1, cs, acc, out, h, hacc => by
    simp only [transformParts] at h
    split at h
    · split at h
      · simp at h
      · simp only [Option.some.injEq] at h; subst h
        intro g hg; exact hacc g (List.mem_reverse.mp hg)
    · split at h
      · simp at h
      · refine transformParts_ok fuel _ (_ :: acc) out h ?_
        intro g hg
        rcases List.mem_cons.mp hg with rfl | hg'
        · exact transformGroup_ok (by assumption)
        · exact hacc g hg'

/-- An emitted transform is a space-joined list of well-formed groups. -/
theorem transformChars_ok {cs r : List Char} (h : transformChars cs = some r) :
    ∃ groups, r = joinSpace groups ∧ ∀ g ∈ groups, groupOk g := by
  unfold transformChars at h
  simp only at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · cases hp : transformParts 8 (trimChars cs) [] with
      | none => simp [hp] at h
      | some groups =>
        simp only [hp, Option.map_some', Option.some.injEq] at h
        subst h
        exact ⟨groups, rfl, transformParts_ok 8 _ [] groups hp (by simp)⟩

end Guard.Props
