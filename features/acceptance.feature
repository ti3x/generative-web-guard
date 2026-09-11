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
