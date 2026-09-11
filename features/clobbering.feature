Feature: Generated names cannot shadow host identifiers or pollute prototypes
  Rules R-CLOBBER-ID-PREFIX, R-CLOBBER-NAME and R-CLOBBER-ATTR-KEYS.

  @rule:R-CLOBBER-ID-PREFIX
  Scenario: Ids are prefixed and references rewritten to match
    Given the generated HTML:
      """
      <label for="root">N</label><input id="root"><table><tr><th headers="x y">h</th></tr></table>
      """
    When every engine validates it
    Then "label" has attribute "for" equal to "g-root"
    And "input" has attribute "id" equal to "g-root"
    And "th" has attribute "headers" equal to "g-x g-y"
    And a change cites rule R-CLOBBER-ID-PREFIX
    And all engines agree

  @rule:R-CLOBBER-ID-PREFIX @cve:CVE-2024-48910
  Scenario: Ids that are not identifiers are dropped
    Given the generated HTML:
      """
      <div id="__proto__"></div><div id="a b"></div><div id="1x"></div>
      """
    When every engine validates it
    Then no attribute matching "^id$" remains
    And a change cites rule R-CLOBBER-ID-PREFIX
    And all engines agree

  @rule:R-CLOBBER-NAME
  Scenario: Name attributes are removed
    Given the generated HTML:
      """
      <input name="getElementById"><p name="body">t</p>
      """
    When every engine validates it
    Then no attribute matching "^name$" remains
    And a change cites rule R-CLOBBER-NAME
    And all engines agree

  @rule:R-CLOBBER-ATTR-KEYS @cve:CVE-2024-48910 @cve:CVE-2024-45801
  Scenario: Prototype-named attributes are removed
    Given the generated HTML:
      """
      <div __proto__="x" constructor="y" prototype="z" class="card">t</div>
      """
    When every engine validates it
    Then no attribute matching "proto|constructor|prototype" remains
    And a change cites rule R-CLOBBER-ATTR-KEYS
    And all engines agree
