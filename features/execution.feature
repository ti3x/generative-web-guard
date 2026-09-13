Feature: Generated content cannot execute script
  Rules R-EXEC-SCRIPT and R-EXEC-HANDLER. The policy removes every script
  element and every event handler attribute; the frame CSP and the renderer
  are the second and third lines behind it.

  Background:
    Given the class allowlist is "card muted"

  @rule:R-EXEC-SCRIPT
  Scenario: A script element is removed with its content
    Given the generated HTML:
      """
      <div class="card"><script>alert(1)</script><p>hi</p></div>
      """
    When every engine validates it
    Then no element "script" remains
    And the text does not contain "alert(1)"
    And the elements remaining are "html:div html:p"
    And a change cites rule R-EXEC-SCRIPT
    And all engines agree

  @rule:R-EXEC-SCRIPT
  Scenario: SVG script and animation elements are removed
    Given the generated HTML:
      """
      <svg><script>alert(1)</script><animate attributeName="x" to="1"/><set attributeName="onload" to="alert(1)"/><rect width="1" height="1"/></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:rect"
    And a change cites rule R-EXEC-SCRIPT
    And all engines agree

  @rule:R-EXEC-HANDLER
  Scenario: Event handler attributes are removed everywhere
    Given the generated HTML:
      """
      <div onclick="x()" ONMOUSEOVER="y()"><p onerror="z()">t</p><details open ontoggle="w()"><summary>s</summary></details></div>
      """
    When every engine validates it
    Then no attribute matching "^on" remains
    And a change cites rule R-EXEC-HANDLER
    And all engines agree

  @rule:R-EXEC-HANDLER @rule:R-RES-URL-ATTR
  Scenario Outline: OWASP filter-evasion payloads leave no executable surface
    Given the generated HTML:
      """
      <payload>
      """
    When every engine validates it
    Then no element "script" remains
    And no element "img" remains
    And no attribute matching "^on|src|href" remains
    And the text does not contain "javascript:"
    And all engines agree

    Examples:
      | payload                                                     |
      | <IMG SRC=JaVaScRiPt:alert('XSS')>                           |
      | <IMG """><SCRIPT>alert("XSS")</SCRIPT>">                    |
      | <a onmouseover="alert(document.cookie)">xxs link</a>        |
      | <IMG SRC=# onmouseover="alert('xxs')">                      |
      | <<SCRIPT>alert("XSS");//<</SCRIPT>                          |
      | <SCRIPT SRC=//ha.ckers.org/.j>                              |
      | <BODY ONLOAD=alert('XSS')>                                  |
      | <svg/onload=alert(1)>                                       |
      | <svg><animate onbegin=alert(1) attributeName=x dur=1s>      |
      | <details open ontoggle=alert(1)>                            |
      | <input onfocus=alert(1) autofocus>                          |
      | <svg><a xlink:href="javascript:alert(1)"><text x=20 y=20>XSS</text></a> |

  # Removing the JavaScript identifier denylist from the execution path does
  # not change anything below: markup policy checks stay mandatory, and they
  # now run behind the bounded parse5 frontend in the policy Worker.
  @rule:R-EXEC-SCRIPT @rule:R-EXEC-HANDLER
  Scenario: Executable surface is still removed when the document arrives through the bounded frontend
    Given the generated HTML is preprocessed:
      """
      <div class="card"><script>alert(1)</script><p onclick="alert(2)">hi</p></div>
      """
    When the frontend preprocesses it
    Then preprocessing accepts it
    When the policy validates the preprocessed tree
    Then no element "script" remains
    And no attribute matching "^on" remains
    And the elements remaining are "html:div html:p"
    And the text "hi" is kept
    And a change cites rule R-EXEC-SCRIPT
