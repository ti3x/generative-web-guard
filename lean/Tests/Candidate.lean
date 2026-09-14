import Guard.Policy.Candidate
import Guard.Policy.Check
import Guard.Io.Decode

namespace Tests.Candidate
open Guard
private def ctx : Ctx := { classes := ["card"] }
private def el (tag : String) (attrs : List (String × String) := []) (children : List Node := []) : Node :=
  .el .html tag attrs children
private def accepts (tree : List Node) : Bool := acceptCandidate defaultProfile ctx tree

#guard accepts []
#guard accepts [el "div" [("class", "card")] [.text "hello"]]
#guard !(accepts [el "script"])
#guard !(accepts [el "DIV"])
#guard !(accepts [.text ""])
#guard !(accepts [.text "bad\x00text"])
#guard !(accepts [el "div" [("title", "a"), ("class", "card")]])
#guard !(accepts [el "div" [("class", "card"), ("class", "card")]])
#guard !(accepts [el "div" [("CLASS", "card")]])
#guard !(accepts [el "div" [("class", "card evil")]])
#guard !(accepts [el "div" [("onclick", "alert(1)")]])
#guard !(accepts [el "button"])
#guard accepts [el "button" [("type", "button")]]
#guard !(accepts [.el .svg "circle" [] []])
#guard !(accepts [.el .svg "svg" [] [.el .html "div" [] []]])
#guard !(accepts [.el .svg "svg" [] [.el .svg "title" [] [.el .svg "tspan" [] []]]])
#guard !(accepts [.el .svg "svg" [] [.el .svg "circle" [("fill", "url(#x)")] []]])

private def dec (s : String) : Bool := match J.parse s with
  | .error _ => false
  | .ok j => (Io.decodeCandidateDocument Io.abiLimits j).isOk
#guard dec "{\"kind\":\"root\",\"children\":[]}"
#guard !(dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"comment\"}]}")
#guard !(dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"root\",\"children\":[]}]}")
#guard !(dec "{\"kind\":\"root\",\"children\":[],\"children\":[]}")
#guard !(dec "{\"kind\":\"root\",\"children\":[{\"kind\":\"el\",\"ns\":\"HTML\",\"tag\":\"div\",\"attrs\":[],\"children\":[]}]}")

-- Accepted reference outputs must also pass the new predicate. This is a
-- behavioral regression check, not the universal converse of the replay theorem.
private def preserved (raw : List Raw) : Bool := match checkTree ctx raw with
  | .rejected _ => true
  | .validated tree _ => accepts tree
#guard preserved [.el "html" "DIV" [("class", "card evil"), ("title", " x ")] [.text "hi\x00!"]]
#guard preserved [.el "html" "button" [] [], .el "html" "input" [] []]
#guard preserved [.el "svg" "svg" [("viewbox", "0 0 100 100")] [.el "svg" "circle" [("fill", "red")] []]]
end Tests.Candidate
