/-!
Minimal JSON reader and writer with no dependency on the `Lean` package.
`Lean.Data.Json` pulls the compiler library into the WebAssembly build
(tens of megabytes); the checker only needs objects, arrays, strings and
integers, so this module keeps the artifact small and the trusted core
readable.

Numbers are kept as their source text: the checker never does arithmetic on
JSON numbers and this avoids any float handling.
-/

namespace Guard.J

inductive Json where
  | null
  | bool (b : Bool)
  | num (raw : String)
  | str (s : String)
  | arr (xs : List Json)
  | obj (kvs : List (String × Json))
deriving Inhabited, Repr

def Json.get? (j : Json) (key : String) : Option Json :=
  match j with
  | .obj kvs => kvs.lookup key
  | _ => none

def Json.asStr? : Json → Option String
  | .str s => some s
  | _ => none

def Json.asArr? : Json → Option (List Json)
  | .arr xs => some xs
  | _ => none

def Json.getStr (j : Json) (key : String) (default : String := "") : String :=
  ((j.get? key).bind Json.asStr?).getD default

def Json.getArr (j : Json) (key : String) : List Json :=
  ((j.get? key).bind Json.asArr?).getD []

/-! ### Writer -/

def hexDigit (n : Nat) : Char := if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

def escapeString (s : String) : String :=
  let body := s.toList.foldl (init := "") fun acc c =>
    match c with
    | '"' => acc ++ "\\\""
    | '\\' => acc ++ "\\\\"
    | '\n' => acc ++ "\\n"
    | '\r' => acc ++ "\\r"
    | '\t' => acc ++ "\\t"
    | c =>
      if c.val < 0x20 || c.val == 0x7f || c.val == 0x2028 || c.val == 0x2029 then
        let n := c.toNat
        acc ++ "\\u" ++ String.mk [hexDigit (n / 4096 % 16), hexDigit (n / 256 % 16), hexDigit (n / 16 % 16), hexDigit (n % 16)]
      else acc.push c
  "\"" ++ body ++ "\""

partial def Json.compress : Json → String
  | .null => "null"
  | .bool true => "true"
  | .bool false => "false"
  | .num raw => raw
  | .str s => escapeString s
  | .arr xs => "[" ++ ",".intercalate (xs.map Json.compress) ++ "]"
  | .obj kvs => "{" ++ ",".intercalate (kvs.map fun (k, v) => escapeString k ++ ":" ++ v.compress) ++ "}"

/-! ### Reader -/

private def isWs (c : Char) : Bool := c == ' ' || c == '\t' || c == '\n' || c == '\r'
private def isDigit (c : Char) : Bool := c ≥ '0' && c ≤ '9'

private def hexVal (c : Char) : Option Nat :=
  if c ≥ '0' && c ≤ '9' then some (c.toNat - 48)
  else if c ≥ 'a' && c ≤ 'f' then some (c.toNat - 87)
  else if c ≥ 'A' && c ≤ 'F' then some (c.toNat - 55)
  else none

private def hex4 : List Char → Option (Nat × List Char)
  | a :: b :: c :: d :: rest => do
    let a ← hexVal a; let b ← hexVal b; let c ← hexVal c; let d ← hexVal d
    pure (((a * 16 + b) * 16 + c) * 16 + d, rest)
  | _ => none

private def mkChar (n : Nat) : Char :=
  if n < 0xd800 || (n ≥ 0xe000 && n < 0x110000) then Char.ofNat n else '�'

/-- Parses the body of a string after the opening quote. -/
private partial def parseStringBody (cs : List Char) (acc : List Char) : Option (String × List Char) :=
  match cs with
  | [] => none
  | '"' :: rest => some (String.mk acc.reverse, rest)
  | '\\' :: e :: rest =>
    match e with
    | '"' => parseStringBody rest ('"' :: acc)
    | '\\' => parseStringBody rest ('\\' :: acc)
    | '/' => parseStringBody rest ('/' :: acc)
    | 'b' => parseStringBody rest ('\x08' :: acc)
    | 'f' => parseStringBody rest ('\x0c' :: acc)
    | 'n' => parseStringBody rest ('\n' :: acc)
    | 'r' => parseStringBody rest ('\r' :: acc)
    | 't' => parseStringBody rest ('\t' :: acc)
    | 'u' =>
      match hex4 rest with
      | none => none
      | some (hi, rest') =>
        if hi ≥ 0xd800 && hi < 0xdc00 then
          match rest' with
          | '\\' :: 'u' :: rest'' =>
            match hex4 rest'' with
            | some (lo, rest''') =>
              if lo ≥ 0xdc00 && lo < 0xe000 then
                parseStringBody rest''' (mkChar (0x10000 + (hi - 0xd800) * 0x400 + (lo - 0xdc00)) :: acc)
              else parseStringBody rest' ('�' :: acc)
            | none => parseStringBody rest' ('�' :: acc)
          | _ => parseStringBody rest' ('�' :: acc)
        else parseStringBody rest' (mkChar hi :: acc)
    | _ => none
  | c :: rest => parseStringBody rest (c :: acc)

private def skipWs (cs : List Char) : List Char := cs.dropWhile isWs

private def startsWith (cs : List Char) (lit : String) : Option (List Char) :=
  let l := lit.toList
  if cs.take l.length == l then some (cs.drop l.length) else none

mutual
  private partial def parseValue (cs : List Char) : Option (Json × List Char) :=
    match skipWs cs with
    | [] => none
    | '"' :: rest => (parseStringBody rest []).map fun (s, r) => (.str s, r)
    | '[' :: rest => parseArray (skipWs rest) []
    | '{' :: rest => parseObject (skipWs rest) []
    | cs' =>
      match startsWith cs' "true" with
      | some r => some (.bool true, r)
      | none =>
        match startsWith cs' "false" with
        | some r => some (.bool false, r)
        | none =>
          match startsWith cs' "null" with
          | some r => some (.null, r)
          | none =>
            let numChars := cs'.takeWhile fun c => isDigit c || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E'
            if numChars.isEmpty then none else some (.num (String.mk numChars), cs'.drop numChars.length)

  private partial def parseArray (cs : List Char) (acc : List Json) : Option (Json × List Char) :=
    match cs with
    | ']' :: rest => some (.arr acc.reverse, rest)
    | _ =>
      match parseValue cs with
      | none => none
      | some (v, rest) =>
        match skipWs rest with
        | ',' :: rest' => parseArray (skipWs rest') (v :: acc)
        | ']' :: rest' => some (.arr (v :: acc).reverse, rest')
        | _ => none

  private partial def parseObject (cs : List Char) (acc : List (String × Json)) : Option (Json × List Char) :=
    match cs with
    | '}' :: rest => some (.obj acc.reverse, rest)
    | '"' :: rest =>
      match parseStringBody rest [] with
      | none => none
      | some (k, rest') =>
        match skipWs rest' with
        | ':' :: rest'' =>
          match parseValue rest'' with
          | none => none
          | some (v, rest''') =>
            match skipWs rest''' with
            | ',' :: r => parseObject (skipWs r) ((k, v) :: acc)
            | '}' :: r => some (.obj ((k, v) :: acc).reverse, r)
            | _ => none
        | _ => none
    | _ => none
end

/-- Parses a complete JSON document. Trailing whitespace is allowed, anything else is an error. -/
def parse (s : String) : Except String Json :=
  match parseValue s.toList with
  | none => .error "malformed JSON"
  | some (v, rest) => if (skipWs rest).isEmpty then .ok v else .error "trailing characters after JSON value"

end Guard.J
