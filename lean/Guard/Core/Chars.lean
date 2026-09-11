/-!
Character classes shared by every validator, plus UTF-16 length so that
length limits agree with JavaScript. Mirrors the helpers at the top of
`src/policy.js`.
-/

namespace Guard

/-- UTF-16 code unit length, so that length limits agree with JavaScript. -/
def utf16Length (s : String) : Nat :=
  s.foldl (fun n c => n + (if c.val ≥ 0x10000 then 2 else 1)) 0

end Guard

namespace Guard.V

def isDigit (c : Char) : Bool := c ≥ '0' && c ≤ '9'
def isUpper (c : Char) : Bool := c ≥ 'A' && c ≤ 'Z'
def isLower (c : Char) : Bool := c ≥ 'a' && c ≤ 'z'
def isAlpha (c : Char) : Bool := isLower c || isUpper c
def isAlnum (c : Char) : Bool := isDigit c || isAlpha c
def isHex (c : Char) : Bool := isDigit c || (c ≥ 'a' && c ≤ 'f') || (c ≥ 'A' && c ≤ 'F')

/-- JavaScript `\s` and `trim()` whitespace. -/
def isWs (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == '\r' || c.val == 0x0b || c.val == 0x0c ||
  c.val == 0xa0 || c.val == 0x1680 || (c.val ≥ 0x2000 && c.val ≤ 0x200a) ||
  c.val == 0x2028 || c.val == 0x2029 || c.val == 0x202f || c.val == 0x205f ||
  c.val == 0x3000 || c.val == 0xfeff

def isControl (c : Char) : Bool :=
  c.val ≤ 0x08 || c.val == 0x0b || c.val == 0x0c || (c.val ≥ 0x0e && c.val ≤ 0x1f) || c.val == 0x7f

def isBidi (c : Char) : Bool :=
  (c.val ≥ 0x202a && c.val ≤ 0x202e) || (c.val ≥ 0x2066 && c.val ≤ 0x2069)

/-- ASCII-only lowercase, matching `asciiLower` in policy.js. -/
def lowerChar (c : Char) : Char := if isUpper c then Char.ofNat (c.toNat + 32) else c
def asciiLower (s : String) : String := String.mk (s.toList.map lowerChar)

end Guard.V
