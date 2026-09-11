import Guard.Validators.Color

/-!
Colors: the output is a named color, `currentColor`, `#` plus hex digits, or
an `rgb()` form. Rule: R-VAL-COLOR.
-/

namespace Guard.Props

open V

theorem colorChars_ok {cs r : List Char} (h : colorChars cs = some r) :
    namedColors.contains (String.mk r) = true ∨ r = "currentColor".toList ∨
    (∃ hs, r = '#' :: hs ∧ hs.all isHex = true) ∨ rgbOk r = true := by
  unfold colorChars at h
  simp only at h
  split at h
  · simp only [Option.some.injEq] at h; subst h
    split
    · exact Or.inr (Or.inl rfl)
    · exact Or.inl (by assumption)
  · split at h
    · split at h
      · simp only [Option.some.injEq] at h; subst h
        refine Or.inr (Or.inr (Or.inl ⟨_, rfl, ?_⟩))
        simp_all
      · simp at h
    · split at h
      · simp only [Option.some.injEq] at h; subst h
        exact Or.inr (Or.inr (Or.inr (by assumption)))
      · simp at h

end Guard.Props
