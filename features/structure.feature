Feature: Only allowlisted elements survive and non-element nodes are dropped
  Rules R-STRUCT-NON-ELEMENT and R-STRUCT-ELEMENT-ALLOWLIST.

  @rule:R-STRUCT-NON-ELEMENT
  Scenario: Comments and doctypes are removed
    Given the generated HTML:
      """
      <!doctype html><!-- c --><p>a<!-- d -->b</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And the text "ab" is kept
    And a change cites rule R-STRUCT-NON-ELEMENT
    And all engines agree

  @rule:R-STRUCT-ELEMENT-ALLOWLIST
  Scenario: Unknown elements are removed with their content
    Given the generated HTML:
      """
      <blink>b</blink><marquee>m</marquee><custom-el>c</custom-el><p>after</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And the text does not contain "b"
    And a change cites rule R-STRUCT-ELEMENT-ALLOWLIST
    And all engines agree

  @rule:R-STRUCT-ELEMENT-ALLOWLIST
  Scenario: Legacy presentational elements are unwrapped and their text kept
    Given the generated HTML:
      """
      <font color="red">f</font><center>c</center><ins>i</ins><del>d</del><q>q</q><cite>ct</cite>
      """
    When every engine validates it
    Then the element "font" is unwrapped
    And the text "fcidqct" is kept
    And a change cites rule R-STRUCT-ELEMENT-ALLOWLIST
    And all engines agree

  @rule:R-STRUCT-ELEMENT-ALLOWLIST
  Scenario: SVG-looking tags outside an svg root are unknown HTML and removed
    Given the generated HTML:
      """
      <div><rect width="1" height="1"></rect><g></g>ok</div>
      """
    When every engine validates it
    Then the elements remaining are "html:div"
    And the text "ok" is kept
    And a change cites rule R-STRUCT-ELEMENT-ALLOWLIST
    And all engines agree
