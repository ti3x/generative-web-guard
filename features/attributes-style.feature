Feature: Only allowlisted attributes survive and no generated CSS reaches the browser
  Rules R-ATTR-ALLOWLIST, R-ATTR-NAMESPACED, R-STYLE-ELEMENT, R-STYLE-INLINE
  and R-STYLE-CLASS.

  @rule:R-ATTR-ALLOWLIST
  Scenario: Unknown attributes are removed, known ones kept
    Given the generated HTML:
      """
      <p foo="1" data-foo="2" Key="3" title="ok">t</p>
      """
    When every engine validates it
    Then no attribute matching "foo|key" remains
    And "p" has attribute "title" equal to "ok"
    And a change cites rule R-ATTR-ALLOWLIST
    And all engines agree

  @rule:R-ATTR-NAMESPACED
  Scenario: Namespaced attributes are removed
    Given the generated HTML:
      """
      <p xmlns:a="y" xml:lang="z">t</p>
      """
    When every engine validates it
    Then no attribute matching ":" remains
    And a change cites rule R-ATTR-NAMESPACED
    And all engines agree

  @rule:R-STYLE-ELEMENT
  Scenario: Style elements are removed in HTML and SVG
    Given the generated HTML:
      """
      <style>@import url(x)</style><svg><style>rect{fill:url(x)}</style><rect width="1" height="1"/></svg><p>t</p>
      """
    When every engine validates it
    Then no element "style" remains
    And the text does not contain "url("
    And a change cites rule R-STYLE-ELEMENT
    And all engines agree

  @rule:R-STYLE-INLINE
  Scenario: Style attributes are removed without being parsed
    Given the generated HTML:
      """
      <p style="background:url(x);position:fixed" class="card">t</p>
      """
    When every engine validates it
    Then "p" has no attribute "style"
    And "p" has attribute "class" equal to "card"
    And a change cites rule R-STYLE-INLINE
    And all engines agree

  @rule:R-STYLE-CLASS
  Scenario: Class names outside the bundled stylesheet are removed
    Given the class allowlist is "card muted"
    And the generated HTML:
      """
      <p class="card evil muted">t</p><div class="evil">d</div>
      """
    When every engine validates it
    Then "p" has attribute "class" equal to "card muted"
    And "div" has no attribute "class"
    And a change cites rule R-STYLE-CLASS
    And all engines agree
