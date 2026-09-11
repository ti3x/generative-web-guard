import Guard.Core.ListUtil
import Guard.Core.Limits

/-!
Closed keyword sets, fixed values, bounded plain text and language tags.
Rules: R-VAL-KEYWORD, R-TEXT-CONTROL-BIDI.
-/

namespace Guard.V

def oneOf (vs : List String) (v : String) : Option String :=
  let t := trim v
  if vs.contains t then some t else none

def fixed (value : String) (_ : String) : Option String := some value

def plainText (v : String) : Option String :=
  if utf16Length v > limits.maxAttrValueLength then none else some (cleanText v)

def lang (v : String) : Option String :=
  let t := trimChars v.toList
  match splitOnChar t '-' with
  | first :: rest =>
    if (first.length == 2 || first.length == 3) && first.all isAlpha && rest.length ≤ 3 &&
       rest.all (fun p => p.length ≥ 2 && p.length ≤ 8 && p.all isAlnum)
    then some (String.mk t) else none
  | [] => none

end Guard.V
