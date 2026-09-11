Feature: Generated content cannot cause a network request
  Rules R-RES-ELEMENT, R-RES-SVG-REF and R-RES-URL-ATTR. Every element that
  loads or embeds a resource is removed, every SVG reference element is
  removed, and every URL-valued attribute is removed. The frame CSP
  (default-src 'none') is the second line behind the policy.

  @rule:R-RES-ELEMENT
  Scenario: Resource-loading HTML elements are removed with their content
    Given the generated HTML:
      """
      <img src="https://x/a.png" srcset="b 2x"><video poster="p" src="v"></video><iframe src="x"></iframe><object data="x"></object><embed src="x"><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0;url=x"><base href="x"><p>after</p>
      """
    When every engine validates it
    Then the elements remaining are "html:p"
    And no attribute matching "src|href|poster|data|content" remains
    And a change cites rule R-RES-ELEMENT
    And all engines agree

  @rule:R-RES-SVG-REF
  Scenario: SVG elements that reference resources are removed
    Given the generated HTML:
      """
      <svg><image href="x"></image><use href="#a"></use><feImage href="x"></feImage><textPath href="#p">t</textPath><pattern></pattern><filter></filter><mask></mask><marker></marker><clipPath></clipPath><linearGradient></linearGradient><rect width="1" height="1"></rect></svg>
      """
    When every engine validates it
    Then the elements remaining are "svg:svg svg:rect"
    And no attribute matching "href" remains
    And a change cites rule R-RES-SVG-REF
    And all engines agree

  @rule:R-RES-URL-ATTR
  Scenario: URL-valued attributes are removed from allowed elements
    Given the generated HTML:
      """
      <p src="x" href="y" formaction="z" ping="w" background="b" cite="c">t</p><table><tr><td background="x">c</td></tr></table>
      """
    When every engine validates it
    Then no attribute matching "src|href|formaction|ping|background|cite" remains
    And the text "t" is kept
    And a change cites rule R-RES-URL-ATTR
    And all engines agree

  @rule:R-RES-URL-ATTR @rule:R-ATTR-NAMESPACED
  Scenario: xlink:href is removed even though it is namespaced
    Given the generated HTML:
      """
      <svg><rect xlink:href="javascript:alert(1)" width="1" height="1"/></svg>
      """
    When every engine validates it
    Then no attribute matching "href" remains
    And "rect" has attribute "width" equal to "1"
    And a change cites rule R-RES-URL-ATTR
    And all engines agree
