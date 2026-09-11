import Guard.Validators
import Guard.Rules

/-!
Attribute validator descriptors. Tables are data (`Val` values); `Val.apply`
interprets them. Mirrors the validator functions and factories in
`src/policy.js`.
-/

namespace Guard

open V

inductive Val where
  | num | nonNeg | unit | lenPct | path | transform | viewBox | color | text | ident | id | idRefs | cls | lang
  | int (lo hi : Int)
  | numList (max : Nat)
  | oneOf (vs : List String)
  | fixed (v : String)
  /-- Same validator, different rule cited on failure or rewrite. -/
  | tagged (rule : String) (v : Val)
deriving Repr, BEq, Inhabited

structure Ctx where
  classes : List String

def Val.apply (ctx : Ctx) : Val → String → Option String
  | .num => canonicalNumber
  | .nonNeg => nonNegative
  | .unit => unitInterval
  | .lenPct => lengthOrPercent
  | .path => pathData
  | .transform => V.transform
  | .viewBox => V.viewBox
  | .color => V.color
  | .text => plainText
  | .ident => V.ident
  | .id => idValue
  | .idRefs => idRefList
  | .cls => classValue ctx.classes
  | .lang => V.lang
  | .int lo hi => boundedInt lo hi
  | .numList max => numberList max
  | .oneOf vs => V.oneOf vs
  | .fixed v => V.fixed v
  | .tagged _ v => v.apply ctx

/-- The rule a validator cites when it drops or rewrites a value. Mirrors the
`.rule` property on validators in `src/policy.js`. -/
def Val.rule : Val → String
  | .num | .nonNeg | .unit | .lenPct | .int _ _ | .numList _ | .viewBox => R.VAL_NUMBER
  | .path => R.VAL_PATH
  | .transform => R.VAL_TRANSFORM
  | .color => R.VAL_COLOR
  | .text => R.TEXT_CONTROL_BIDI
  | .ident | .oneOf _ | .fixed _ | .lang => R.VAL_KEYWORD
  | .id | .idRefs => R.CLOBBER_ID_PREFIX
  | .cls => R.STYLE_CLASS
  | .tagged rule _ => rule

abbrev Table := List (String × Val)

end Guard
