import Guard.Core.ListUtil
import Guard.Core.Limits

/-!
Canonical bounded decimals, integers, number lists and viewBox.
Rule: R-VAL-NUMBER. Mirrors `boundedNumber`, `boundedInt`, `numberList`,
`viewBox` in `src/policy.js`. Proofs: `Guard.Props.Number`.
-/

namespace Guard.V

def numberCharOk (c : Char) : Bool := isDigit c || c == '.' || c == '-'

def splitSign : List Char → Bool × List Char
  | '-' :: r => (true, r)
  | r => (false, r)

/-- After the integer digits: nothing, or `.` followed by one or more digits. -/
def splitFrac : List Char → Option (List Char)
  | [] => some []
  | c :: r => if c == '.' && !r.isEmpty && r.all isDigit then some r else none

def assembleNumber (neg : Bool) (int frac : List Char) : List Char :=
  (if neg then ['-'] else []) ++ int ++ (if frac.isEmpty then [] else '.' :: frac)

/--
Canonical bounded decimal. Grammar: `-? (digits+ | digits* . digits+)`.
Leading zeros in the integer part and trailing zeros in the fraction are
dropped, `-0` becomes `0`, and the magnitude must be at most 1e6.
Mirrors `boundedNumber` in policy.js exactly.
-/
def canonicalFromParts (neg : Bool) (intDs fracDs : List Char) : Option (List Char) :=
  if intDs.isEmpty && fracDs.isEmpty then none
  else if intDs.length > 7 then none
  else
    let int := dropLeadingZeros intDs
    let frac := dropTrailingZeros fracDs
    let n := digitsToNat int
    if n > limits.maxNumberMagnitude || (n == limits.maxNumberMagnitude && !frac.isEmpty) then none
    else if int == ['0'] && frac.isEmpty then some ['0']
    else some (assembleNumber neg int frac)

def canonicalNumberChars (cs : List Char) : Option (List Char) :=
  let p := splitSign (trimChars cs)
  let intDs := p.2.takeWhile isDigit
  match splitFrac (p.2.drop intDs.length) with
  | none => none
  | some fracDs => canonicalFromParts p.1 intDs fracDs

def canonicalNumber (v : String) : Option String := (canonicalNumberChars v.toList).map String.mk

def isNegative (canon : String) : Bool := canon.startsWith "-"
def isZero (canon : String) : Bool := canon == "0"

def nonNegative (v : String) : Option String :=
  match canonicalNumber v with
  | some c => if isNegative c then none else some c
  | none => none

def unitInterval (v : String) : Option String :=
  match canonicalNumber v with
  | some c =>
    if isNegative c then none
    else if c == "1" || c == "0" || c.startsWith "0." then some c
    else none
  | none => none

def lengthOrPercent (v : String) : Option String :=
  let cs := trimChars v.toList
  match cs.reverse with
  | '%' :: r => (canonicalNumber (String.mk r.reverse)).map (· ++ "%")
  | _ => canonicalNumber v

/-- Signed decimal integer, without a range test. Split out from `boundedInt`
so that widening the range is a statement about the range test alone. -/
def intParse (v : String) : Option Int :=
  let p := splitSign (trimChars v.toList)
  let ds := p.2
  if ds.isEmpty || !ds.all isDigit || ds.length > 15 then none
  else
    let n : Int := digitsToNat ds
    some (if p.1 then -n else n)

/-- Integer in [lo, hi], canonical (no leading zeros, no -0). -/
def boundedInt (lo hi : Int) (v : String) : Option String :=
  match intParse v with
  | none => none
  | some n => if n < lo || n > hi then none else some (toString n)

/-- The list part of `numberListChars`, with the length bound applied to an
already-split list, so that widening the bound is a statement about the bound. -/
def numberListOf (max : Nat) (parts : List (List Char)) : Option (List Char) :=
  if parts.isEmpty || parts.length > max then none
  else (allSome (parts.map canonicalNumberChars)).map joinSpace

/-- Whitespace or comma separated canonical numbers, joined by single spaces. -/
def numberListChars (max : Nat) (cs : List Char) : Option (List Char) :=
  numberListOf max (splitRuns true (trimChars cs))

def numberList (max : Nat) (v : String) : Option String :=
  (numberListChars max v.toList).map String.mk

def viewBox (v : String) : Option String :=
  match numberList 4 v with
  | none => none
  | some nums =>
    match (splitRuns false nums.toList).map String.mk with
    | [_, _, w, h] => if !isNegative w && !isZero w && !isNegative h && !isZero h then some nums else none
    | _ => none

end Guard.V
