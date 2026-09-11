Feature: Raw-text and template contexts cannot smuggle markup
  Rules R-RCDATA-RAWTEXT, R-RCDATA-TEMPLATE and R-RCDATA-NO-REPARSE. Raw-text
  elements are removed with their content, template content is surfaced and
  removed, and text in textarea or SVG title stays text because the validated
  tree is never serialized and re-parsed.

  @rule:R-RCDATA-RAWTEXT
  Scenario: Raw-text elements are removed with their content
    Given the generated HTML:
      """
      <noscript><img src=x onerror=alert(1)></noscript><xmp><b>x</b></xmp><noembed>n</noembed><noframes>f</noframes><p>after</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And the text does not contain "x"
    And a change cites rule R-RCDATA-RAWTEXT
    And all engines agree

  @rule:R-RCDATA-RAWTEXT
  Scenario: An HTML title element is removed
    Given the generated HTML:
      """
      <title><b>t</b></title><p>a</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And a change cites rule R-RCDATA-RAWTEXT
    And all engines agree

  @rule:R-RCDATA-TEMPLATE
  Scenario: Template content is visible to the policy and removed
    Given the generated HTML:
      """
      <template><script>1</script><p>t</p></template><p>a</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And the text does not contain "t</p>"
    And a change cites rule R-RCDATA-TEMPLATE
    And all engines agree

  @rule:R-RCDATA-NO-REPARSE
  Scenario: Escaped markup inside a textarea stays text
    Given the generated HTML:
      """
      <textarea>&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>
      """
    When every engine validates it
    Then the elements remaining are "html:textarea"
    And the text "</textarea><script>alert(1)</script>" is kept
    And all engines agree

  @rule:R-RCDATA-NO-REPARSE
  Scenario: Escaped markup inside an SVG title stays text
    Given the generated HTML:
      """
      <svg><title>&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;</title><rect width="1" height="1"/></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:title svg:rect"
    And the text "</title><img src=x onerror=alert(1)>" is kept
    And no attribute matching "^on|src" remains
    And all engines agree
