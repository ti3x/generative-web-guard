Feature: The renderer builds DOM from the tree with constructors only
  Rule R-RENDER-CONSTRUCTORS-ONLY. Elements are created with createElementNS
  in the declared namespace, attributes set only for allowlisted names, text
  set as data. No HTML string is ever parsed, and forged nodes are refused
  even when handed to the renderer directly.

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: Elements land in the right namespace and text is never parsed
    Given a rendered tree from HTML:
      """
      <div class="card"><p>hi &lt;b&gt;</p><svg viewBox="0 0 10 10"><rect width="1" height="1"></rect></svg></div>
      """
    Then no HTML sink was used
    And the first element is "div" in the "html" namespace
    And the "p" element contains a single text node "hi <b>"
    And the SVG child "rect" is in the SVG namespace

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: A forged script element is refused even if handed to the renderer directly
    Given the renderer is handed a forged "script" element
    Then the renderer refuses with "refused element"

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario Outline: Dangerous attribute names are refused even if handed to the renderer directly
    Given the renderer is handed a div with attribute "<name>"
    Then the renderer refuses with "refused attribute"

    Examples:
      | name       |
      | onclick    |
      | style      |
      | xlink:href |
      | srcdoc     |

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: Patching updates in place and removes stale attributes
    Given a rendered tree from HTML:
      """
      <p class="card" title="a">one</p>
      """
    When the tree is re-rendered from HTML:
      """
      <p class="btn">two</p>
      """
    Then no HTML sink was used
    And the "p" element contains a single text node "two"
    And the "p" element no longer has attribute "title"

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: Focus, selection and a typed value survive a re-render
    Given a rendered tree from HTML:
      """
      <div><label for="q">Search</label><input id="q" data-action="filter" value=""><button data-action="go">go</button></div>
      """
    When the user focuses the input and types "hello"
    And the tree is re-rendered from HTML:
      """
      <div><label for="q">Search (updated)</label><input id="q" data-action="filter" value=""><button data-action="go">go</button></div>
      """
    Then no HTML sink was used
    And focus stays on the input with value "hello" and selection 1 to 2
    When the tree is re-rendered from HTML:
      """
      <div><label for="q">S</label><input id="q" data-action="filter" value="reset"><button data-action="go">go</button></div>
      """
    Then the input value is "reset"

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: A checkbox follows the validated attribute only when it changes
    Given a rendered tree from HTML:
      """
      <input type="checkbox" data-action="t">
      """
    When the user checks the checkbox
    And the tree is re-rendered from HTML:
      """
      <input type="checkbox" data-action="t">
      """
    Then the checkbox is "checked"
    When the tree is re-rendered from HTML:
      """
      <input type="checkbox" data-action="t" checked>
      """
    Then the checkbox is "checked"
    When the tree is re-rendered from HTML:
      """
      <input type="checkbox" data-action="t">
      """
    Then the checkbox is "unchecked"

  @rule:R-RENDER-CONSTRUCTORS-ONLY
  Scenario: Clearing empties the mount
    Given a rendered tree from HTML:
      """
      <p>a</p><p>b</p>
      """
    Then the mount has 2 child nodes
    When the renderer is cleared
    Then the mount has 0 child nodes
