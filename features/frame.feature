Feature: The rendering frame accepts only validated trees and well-typed messages
  Rules R-FRAME-FIXED-POINT, R-FRAME-MESSAGE-SCHEMA and R-FRAME-CSP-SINKS.

  @rule:R-FRAME-FIXED-POINT
  Scenario: A forged tree with a script element is not a fixed point and is refused
    Given a frame host
    And a forged tree containing a "script" element
    Then the tree is not a policy fixed point
    When the host is asked to render it
    Then the host refuses to render it

  @rule:R-FRAME-FIXED-POINT
  Scenario: A forged tree with an event handler attribute is refused
    Given a frame host
    And a forged tree with attribute "onclick" on a div
    Then the tree is not a policy fixed point
    When the host is asked to render it
    Then the host refuses to render it

  @rule:R-FRAME-FIXED-POINT
  Scenario: A tree that is not canonical is not a fixed point
    Given a tree with unsorted attributes
    Then the tree is not a policy fixed point

  @rule:R-FRAME-FIXED-POINT
  Scenario: Policy output is a fixed point and is accepted
    Given a frame host
    And a validated tree from the HTML "<div class=\"card\"><h1 id=\"t\">T</h1><button data-action=\"go\">go</button></div>"
    Then the tree is a policy fixed point
    When the host is asked to render it
    Then the host accepts it for rendering

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: Messages from a window other than the frame are ignored
    Given a frame host
    And a frame event:
      """
      {"type":"click","action":"go"}
      """
    When the host receives that event from an unrelated window
    Then the host ignores it

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: Only known, well-typed own fields survive the schema check
    Given a frame event:
      """
      {"type":"click","action":"go","value":"v","extra":1}
      """
    When the event is schema-checked
    Then the event is accepted as:
      """
      {"type":"click","action":"go","value":"v"}
      """

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: Inherited fields are not read
    Given a frame event with an inherited field
    When the event is schema-checked
    Then the event is accepted as:
      """
      {"type":"click","action":"go"}
      """

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: An event with an unknown event type is rejected
    Given a frame event:
      """
      {"type":"submit","action":"go"}
      """
    When the event is schema-checked
    Then the event is rejected

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: An event with an action that is not an identifier is rejected
    Given a frame event:
      """
      {"type":"click","action":"javascript:x"}
      """
    When the event is schema-checked
    Then the event is rejected

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: An event with a checked flag that is not a boolean is rejected
    Given a frame event:
      """
      {"type":"click","action":"go","checked":"true"}
      """
    When the event is schema-checked
    Then the event is rejected

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: An event with a non-integer coordinate is rejected
    Given a frame event:
      """
      {"type":"pointermove","action":"go","x":1.5}
      """
    When the event is schema-checked
    Then the event is rejected

  @rule:R-FRAME-MESSAGE-SCHEMA
  Scenario: An event with a bare string instead of an object is rejected
    Given a frame event:
      """
      "click"
      """
    When the event is schema-checked
    Then the event is rejected

  @rule:R-FRAME-CSP-SINKS
  Scenario: The frame is sandboxed and its policy denies every source
    Given a frame host
    When the frame document is built
    Then the frame is sandboxed with "allow-scripts" only
    And the frame policy contains "default-src 'none'"
    And the frame policy contains "script-src 'sha256-S'"
    And the frame policy contains "style-src 'sha256-C'"
    And the frame policy contains "require-trusted-types-for 'script'"
    And the frame policy contains "trusted-types 'none'"
    And the frame policy contains "form-action 'none'"
    And the frame policy contains "base-uri 'none'"
    And the frame policy contains "<meta name=\"referrer\" content=\"no-referrer\">"
