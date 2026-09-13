Feature: Accepted output satisfies the output policy and is canonical

  @rule:R-CHECK-ACCEPTANCE
  Scenario: Sanitized output is accepted unchanged on revalidation
    Given the generated HTML:
      """
      <div id="x" class="card evil" onclick="alert(1)"><script>1</script><input><svg><circle r="02.00" fill="red"></circle></svg></div>
      """
    When every engine validates it
    Then every engine accepts its output unchanged
    And all engines agree

  @rule:R-CHECK-ACCEPTANCE @rule:R-LIMIT-TREE
  Scenario: Separate text nodes count toward the document node limit
    Given a raw tree with 5001 text nodes
    When every engine validates it
    Then the document is rejected with "too-many-nodes"
    And all engines agree

  # The capability kernel in rules/capabilities.json fixes the closed element
  # and attribute identities, the widest reviewed value grammar for each
  # attribute in its context, the mandatory controls and the absolute resource
  # ceilings. Profile validation runs on rules/policy.json alone, so an invalid
  # configuration fails whether or not a matching exploit is in any corpus.

  @rule:R-CAP-INVENTORY
  Scenario: The shipped profile restricts the reviewed capability kernel
    Given the shipped profile
    When the profile is checked against the capability kernel
    Then the profile is accepted

  @rule:R-CAP-INVENTORY
  Scenario Outline: A profile cannot exceed the capability inventory
    Given the shipped profile with the change "<change>"
    When the profile is checked against the capability kernel
    Then the profile is rejected because it "<reason>"

    Examples: unsafe elements
      | change                     | reason                                     |
      | allow the iframe element   | is excluded by the capability kernel       |
      | allow the svg use element  | is excluded by the capability kernel       |

    Examples: resource URLs given a text grammar
      | change                                        | reason                                     |
      | give div an href attribute validated as text  | is excluded by the capability kernel       |
      | give svg a src attribute validated as text    | is excluded by the capability kernel       |

    Examples: paint as generic text
      | change                            | reason                               |
      | validate svg fill as plain text   | does not restrict the kernel grammar |
      | validate svg stroke as plain text | does not restrict the kernel grammar |

    Examples: widened value grammars
      | change                                    | reason                              |
      | validate stroke-width as a signed number  | does not restrict the kernel grammar |
      | widen the dir enum                        | does not restrict the kernel grammar |
      | widen the aria-level range                | does not restrict the kernel grammar |
      | widen the stroke-dasharray bound          | does not restrict the kernel grammar |

    Examples: new identities and unreviewed removals
      | change                            | reason                                       |
      | invent a data-secret attribute    | is not in the capability inventory           |
      | unwrap script instead of dropping it | is not a reviewed unwrappable element     |

  @rule:R-CAP-INVENTORY
  Scenario Outline: SVG paint must keep restricted solid-paint validation
    Given the shipped profile with the change "<change>"
    When the profile is checked against the capability kernel
    Then the kernel grammar for "<attribute>" remains "<family>"

    Examples:
      | change                            | attribute | family |
      | validate svg fill as plain text   | fill      | color  |
      | validate svg stroke as plain text | stroke    | color  |

  @rule:R-CAP-CEILINGS
  Scenario Outline: A profile cannot raise a hard limit above the kernel ceiling
    Given the shipped profile with the change "<change>"
    When the profile is checked against the capability kernel
    Then the profile is rejected because it "<reason>"

    Examples:
      | change                          | reason                              |
      | raise the node limit            | exceeds the kernel ceiling 5000     |
      | raise the attribute value limit | exceeds the kernel ceiling 2000     |
      | raise the traversal ceiling     | exceeds the kernel ceiling 256      |

  @rule:R-CAP-CONTROLS
  Scenario Outline: A profile cannot weaken a mandatory control or text-only context
    Given the shipped profile with the change "<change>"
    When the profile is checked against the capability kernel
    Then the profile is rejected because it "<reason>"

    Examples:
      | change                                 | reason                                    |
      | drop the forced button type            | html button must force type               |
      | force button type submit               | html button must force type               |
      | drop the forced input autocomplete     | html input must force autocomplete        |
      | drop the mandatory input type attribute | must keep the mandatory attribute type   |
      | open the svg title text-only context   | must remain a text-only context           |

  @rule:R-CAP-INVENTORY @rule:R-CAP-CEILINGS @rule:R-CAP-CONTROLS
  Scenario Outline: A profile may restrict the kernel further
    Given the shipped profile with the change "<change>"
    When the profile is checked against the capability kernel
    Then the profile is accepted

    Examples:
      | change                                          |
      | narrow the input type enum                      |
      | narrow the aria-level range                     |
      | pin the dir attribute to one value              |
      | drop the meter element                          |
      | drop the select element and its forced attributes |
      | lower the node and depth limits                 |
      | shrink the stroke-dasharray bound               |
      | make svg text a text-only context               |
