import Guard.Policy.Accept
import Guard.Policy.Tables.Attrs

/-!
Candidate-only acceptance. Unlike `checkTree`, this entry point neither
constructs an output nor repairs its input. The additional representation
checks make explicit the canonicality obligations previously checked by replay.

This module deliberately does not import the reference normalizer or proofs.
The production ABI may use it only after the reference-connection proofs pass.
-/
namespace Guard
open V

/-- The exact attribute-name representation used by the reference normalizer. -/
def canonicalAttrName (ns : Ns) (name : String) : String :=
  let lower := asciiLower name
  if ns == .svg then (svgCanonical.lookup lower).getD lower else lower

/-- Strict order also rules out duplicate attribute names. -/
def orderedAttrs (attrs : List (String × String)) : Bool :=
  decide (attrs.Pairwise (fun a b => a.1 ≤ b.1 ∧ a.1 ≠ b.1))

mutual
def nodeRepresentationOk (prof : Profile) : Node → Bool
  | .text s => utf16Length s != 0
  | .el ns tag attrs children =>
    asciiLower tag == tag && orderedAttrs attrs &&
    attrs.all (fun (name, value) => canonicalAttrName ns name == name &&
      utf16Length value ≤ prof.limits.maxAttrValueLength * 10) &&
    nodesRepresentationOk prof children

def nodesRepresentationOk (prof : Profile) : List Node → Bool
  | [] => true
  | node :: nodes => nodeRepresentationOk prof node && nodesRepresentationOk prof nodes
end

/-- A proposal is accepted only if both its semantics and representation pass.
The result authorizes this exact tree; there is no normalization or fallback. -/
def acceptCandidate (prof : Profile) (ctx : Ctx) (tree : List Node) : Bool :=
  prof.permits ctx tree && nodesRepresentationOk prof tree

end Guard
