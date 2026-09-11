Feature: Generated content cannot navigate or submit
  Rules R-NAV-ANCHOR and R-NAV-FORM. Anchors are unwrapped in HTML and
  removed in SVG; forms are unwrapped. No href, action, method or target
  survives.

  @rule:R-NAV-ANCHOR
  Scenario: HTML anchors are unwrapped and their text kept
    Given the generated HTML:
      """
      <p><a href="https://x/" target="_blank" ping="p">link</a> text</p>
      """
    When every engine validates it
    Then the element "a" is unwrapped
    And the text "link" is kept
    And no attribute matching "href|target|ping" remains
    And a change cites rule R-NAV-ANCHOR
    And all engines agree

  @rule:R-NAV-ANCHOR
  Scenario: SVG anchors are removed with their content
    Given the generated HTML:
      """
      <svg><a href="javascript:alert(1)"><text x="1" y="2">svg link</text></a><rect width="1" height="1"/></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:rect"
    And the text does not contain "svg link"
    And a change cites rule R-NAV-ANCHOR
    And all engines agree

  @rule:R-NAV-FORM
  Scenario: Forms are unwrapped and cannot submit
    Given the generated HTML:
      """
      <form action="https://x/" method="post" target="_top"><input type="text"><button>Go</button></form>
      """
    When every engine validates it
    Then the element "form" is unwrapped
    And no attribute matching "action|method|target" remains
    And "button" has attribute "type" equal to "button"
    And a change cites rule R-NAV-FORM
    And all engines agree
