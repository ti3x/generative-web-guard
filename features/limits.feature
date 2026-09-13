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

  # --- Bounded preprocessing (R3) -------------------------------------------
  # These scenarios sit in front of the checker: they bound the work the parser
  # and the adapter do on attacker-controlled input. The recursive adapter
  # overflowed the JavaScript stack on the first one, before any policy limit
  # could apply. Nesting is counted for allowed, unwrapped and dropped
  # elements alike, because the input cost is the same either way.

  @rule:R-LIMIT-TREE
  Scenario: 5,000 nested allowed elements are rejected before parsing output
    Given the generated HTML is 5000 nested "div" elements
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-depth-exceeded"
    And the exceeded limit is "maxRawDepth"
    And nothing reached the policy

  @rule:R-LIMIT-TREE
  Scenario: Nesting in unwrapped elements is bounded even though the policy keeps no level for them
    Given the generated HTML is 5000 nested "q" elements
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-depth-exceeded"
    And the exceeded limit is "maxRawDepth"

  @rule:R-LIMIT-TREE
  Scenario: Nesting in dropped elements is bounded even though the output discards them
    Given the generated HTML is 5000 nested "x-drop" elements
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-depth-exceeded"

  @rule:R-LIMIT-TREE
  Scenario: A flat run of siblings is bounded by the raw nodes open at once
    Given the generated HTML is 30000 copies of "<p>x</p>"
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-path-nodes-exceeded"
    And the exceeded limit is "maxRawPathNodes"

  @rule:R-LIMIT-TREE
  Scenario: A wide, shallow tree is bounded by the raw node count
    Given the generated HTML is 200 groups of 40 copies of "<p>x</p>"
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-nodes-exceeded"
    And the exceeded limit is "maxRawNodes"

  @rule:R-LIMIT-TREE
  Scenario: A wide, shallow document above the old node cap is accepted
    Given the generated HTML is 60 groups of 40 copies of "<p>x</p>"
    When the frontend preprocesses it
    Then preprocessing accepts it

  @rule:R-LIMIT-TREE
  Scenario: A source longer than the input limit is rejected without parsing
    Given the generated HTML is 600000 characters of markup
    When the frontend preprocesses it
    Then preprocessing is rejected with "source-too-long"
    And the exceeded limit is "maxSourceCodeUnits"

  @rule:R-LIMIT-TREE @rule:R-STRUCT-NON-ELEMENT
  Scenario: A comment flood is counted although every comment is discarded
    Given the generated HTML is 5000 copies of "<!--c-->"
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-comment-nodes-exceeded"
    And the exceeded limit is "maxRawCommentNodes"

  @rule:R-LIMIT-TREE
  Scenario: A long element name is rejected
    Given the generated HTML is an element whose tag name is 200 characters
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-name-too-long"
    And the exceeded limit is "maxRawNameCodeUnits"

  @rule:R-LIMIT-TREE
  Scenario: A single huge text node is rejected
    Given the generated HTML is a text node of 300000 characters
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-text-too-long"
    And the exceeded limit is "maxRawTextCodeUnits"

  @rule:R-LIMIT-ATTRS
  Scenario: An excessive attribute count is rejected before the policy trims it
    Given the generated HTML is an element with 300 attributes
    When the frontend preprocesses it
    Then preprocessing is rejected with "raw-attrs-exceeded"
    And the exceeded limit is "maxRawAttrsPerElement"

  @rule:R-LIMIT-ATTRS
  Scenario: An attribute count under the input limit still meets the policy's own limit
    Given the generated HTML is an element with 30 attributes
    When the frontend preprocesses it
    Then preprocessing accepts it
    When the policy validates the preprocessed tree
    Then a change cites rule R-LIMIT-ATTRS

  @rule:R-LIMIT-TREE
  Scenario: A document within every input limit is preprocessed and handed to the policy
    Given the generated HTML is preprocessed:
      """
      <div class="card"><p>ok</p><!--c--></div>
      """
    When the frontend preprocesses it
    Then preprocessing accepts it
    And the raw tree has 2 levels
    When the policy validates the preprocessed tree
    Then the text "ok" is kept
    And the elements remaining are "html:div html:p"
