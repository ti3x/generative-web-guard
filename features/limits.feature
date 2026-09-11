Feature: Structural limits reject rather than truncate
  Rules R-LIMIT-TREE and R-LIMIT-ATTRS. Nesting-based mutation XSS works by
  exhausting or bypassing depth checks; this policy refuses the whole document
  instead of keeping a prefix of it.

  @rule:R-LIMIT-TREE @cve:CVE-2024-47875 @cve:CVE-2024-45801
  Scenario: Nesting deeper than the limit rejects the document
    Given the generated HTML:
      """
      <div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div><div>deep</div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div></div>
      """
    When every engine validates it
    Then the document is rejected with "too-deep"
    And all engines agree

  @rule:R-LIMIT-TREE
  Scenario: Nesting within the limit is accepted unchanged
    Given the generated HTML:
      """
      <div><div><div><div><div><div><div><div><div><div>ok</div></div></div></div></div></div></div></div></div></div>
      """
    When every engine validates it
    Then the text "ok" is kept
    And all engines agree

  @rule:R-LIMIT-ATTRS
  Scenario: Attributes beyond the count limit are dropped
    Given the generated HTML:
      """
      <p a1="1" a2="1" a3="1" a4="1" a5="1" a6="1" a7="1" a8="1" a9="1" a10="1" a11="1" a12="1" a13="1" a14="1" a15="1" a16="1" a17="1" a18="1" a19="1" a20="1" a21="1" a22="1" a23="1" a24="1" title="late">t</p>
      """
    When every engine validates it
    Then "p" has no attribute "title"
    And a change cites rule R-LIMIT-ATTRS
    And all engines agree
