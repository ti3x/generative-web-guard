import Guard.Validators.Ident

/-!
Ids: emitted ids carry the prefix and id rewriting is idempotent.
Rule: R-CLOBBER-ID-PREFIX.
-/

namespace Guard.Props

open V

theorem idValueChars_prefixed (cs r : List Char) (h : idValueChars cs = some r) :
    ∃ rest, r = 'g' :: '-' :: rest := by
  unfold idValueChars at h
  split at h
  · split at h
    · simp only [Option.some.injEq] at h; subst h; exact ⟨_, rfl⟩
    · split at h
      · simp only [Option.some.injEq] at h; subst h; exact ⟨_, rfl⟩
      · simp at h
  · split at h
    · simp only [Option.some.injEq] at h; subst h; exact ⟨_, rfl⟩
    · simp at h

/-- Id rewriting is idempotent: validating an emitted id returns it unchanged. -/
theorem idValueChars_idem (cs r : List Char) (h : idValueChars cs = some r) :
    idValueChars r = some r := by
  unfold idValueChars at h
  split at h
  · split at h
    · rename_i hid
      simp only [Option.some.injEq] at h; subst h
      simp [idValueChars, hid]
    · split at h
      · rename_i hid
        simp only [Option.some.injEq] at h; subst h
        simp [idValueChars, idPrefix, hid]
      · simp at h
  · split at h
    · rename_i hid
      simp only [Option.some.injEq] at h; subst h
      simp [idValueChars, idPrefix, hid]
    · simp at h

end Guard.Props
