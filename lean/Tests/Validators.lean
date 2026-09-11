import Guard

/-!
Compile-time unit checks for the validators. Each `#guard` fails the build if
false. Grouped by the rule the validator enforces so a failing check points at
the rule.
-/

open Guard.V

/-! ## R-VAL-NUMBER -/
#guard canonicalNumber "10.50" = some "10.5"
#guard canonicalNumber "007" = some "7"
#guard canonicalNumber "-0" = some "0"
#guard canonicalNumber "-0.0" = some "0"
#guard canonicalNumber ".5" = some "0.5"
#guard canonicalNumber "1." = none
#guard canonicalNumber "1e5" = none
#guard canonicalNumber "NaN" = none
#guard canonicalNumber "Infinity" = none
#guard canonicalNumber "1000000" = some "1000000"
#guard canonicalNumber "1000000.5" = none
#guard canonicalNumber "12345678" = none
#guard boundedInt 1 100 "000100" = some "100"
#guard boundedInt 1 100 "101" = none
#guard numberList 4 "0 0 10.50 5" = some "0 0 10.5 5"
#guard numberList 2 "1,2,3" = none
#guard viewBox "0 0 -1 10" = none
#guard viewBox "0 0 10 5" = some "0 0 10 5"

/-! ## R-VAL-COLOR -/
#guard color "#FF0000" = some "#FF0000"
#guard color "RED" = some "red"
#guard color "currentColor" = some "currentColor"
#guard color "rgb(1, 2, 3)" = some "rgb(1, 2, 3)"
#guard color "rgba( 1% , 2%,3%, .5 )" = some "rgba( 1% , 2%,3%, .5 )"
#guard color "url(#g)" = none
#guard color "expression(1)" = none
#guard color "red;background:url(x)" = none
#guard color "#12345" = none

/-! ## R-VAL-PATH -/
#guard pathData "M0 0L10-5.5.5Z" = some "M 0 0 L 10 -5.5 0.5 Z"
#guard pathData "M 0 0 - L" = none
#guard pathData "L 0 0" = none
#guard pathData "m1.,2" = none
#guard pathData "M0 0 url(x)" = none

/-! ## R-VAL-TRANSFORM -/
#guard transform "translate(1 2) scale(2) rotate(45 1 1) matrix(1 0 0 1 0 0)" = some "translate(1 2) scale(2) rotate(45 1 1) matrix(1 0 0 1 0 0)"
#guard transform "translate(1) , scale(2)" = none
#guard transform "xtranslate(1)" = none
#guard transform "translate (1,2)skewX(3)" = some "translate(1 2) skewX(3)"
#guard transform "scale(1 2 3)" = none

/-! ## R-CLOBBER-ID-PREFIX -/
#guard idValue "name" = some "g-name"
#guard idValue "g-name" = some "g-name"
#guard idValue "__proto__" = none
#guard idValue "a b" = none
#guard idRefList "x y" = some "g-x g-y"

/-! ## R-STYLE-CLASS -/
#guard classValue ["card", "muted"] "card evil muted" = some "card muted"
#guard classValue ["card"] "evil" = none

/-! ## R-VAL-KEYWORD -/
#guard ident "increment" = some "increment"
#guard ident "javascript:x" = none
#guard lang "en-US" = some "en-US"
#guard lang "en-US-x-toolong123" = none
#guard oneOf ["ltr", "rtl"] " rtl " = some "rtl"

/-! ## R-TEXT-CONTROL-BIDI -/
#guard cleanText "a‮b\x00c" = "abc"
#guard plainText "ok" = some "ok"
