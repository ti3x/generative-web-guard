Feature: Foreign content cannot change how markup is interpreted
  Rules R-NS-MATHML and R-NS-POSITION. MathML is never allowed; HTML that the
  parser places inside SVG integration points is removed; anything under an
  SVG title or desc other than text is removed.

  @rule:R-NS-MATHML
  Scenario: MathML is removed with its content
    Given the generated HTML:
      """
      <math><mi>x</mi><annotation-xml encoding="text/html"><script>1</script></annotation-xml></math><p>after</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And the text does not contain "x"
    And a change cites rule R-NS-MATHML
    And all engines agree

  @rule:R-NS-POSITION
  Scenario: HTML inside SVG integration points is removed
    Given the generated HTML:
      """
      <svg><desc><img src=x onerror=alert(1)></desc><title><b>t</b></title><foreignObject><img src=x></foreignObject><rect width="1" height="1"/></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:desc svg:title svg:rect"
    And no attribute matching "^on|src" remains
    And a change cites rule R-NS-POSITION
    And all engines agree

  @rule:R-NS-POSITION
  Scenario: Only text survives under SVG title and desc
    Given the generated HTML:
      """
      <svg><title>a<b>b</b>c</title><desc>d<i>e</i></desc></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:title svg:desc"
    And the text "a" is kept
    And a change cites rule R-NS-POSITION
    And all engines agree
