import Guard.Core.ListUtil

/-!
Identifiers, prefixed ids, id reference lists and class allowlists.
Rules: R-CLOBBER-ID-PREFIX, R-STYLE-CLASS, R-VAL-KEYWORD. Proofs: `Guard.Props.Ident`.
-/

namespace Guard.V

def identChars (cs : List Char) : Bool :=
  match cs with
  | c :: rest => isAlpha c && rest.all (fun d => isAlnum d || d == '_' || d == '-') && cs.length ≤ 64
  | [] => false

def ident (v : String) : Option String :=
  let t := trimChars v.toList
  if identChars t then some (String.mk t) else none

def idPrefix : List Char := ['g', '-']

/-- Ids are emitted with the `g-` prefix. Idempotent (proved in Props). -/
def idValueChars (cs : List Char) : Option (List Char) :=
  match cs with
  | 'g' :: '-' :: rest => if identChars rest then some cs else if identChars cs then some (idPrefix ++ cs) else none
  | _ => if identChars cs then some (idPrefix ++ cs) else none

def idValue (v : String) : Option String :=
  (idValueChars (trimChars v.toList)).map String.mk

def idRefList (v : String) : Option String :=
  let parts := splitRuns false (trimChars v.toList)
  if parts.isEmpty || parts.length > 8 then none
  else (allSome (parts.map idValueChars)).map (fun ids => String.mk (joinSpace ids))

def classValue (allow : List String) (v : String) : Option String :=
  let parts := (splitRuns false (trimChars v.toList)).map String.mk
  let kept := parts.filter allow.contains
  if kept.isEmpty then none else some (String.intercalate " " kept)

end Guard.V
