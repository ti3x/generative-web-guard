Feature: Form controls cannot steal focus or trigger browser autofill
  Rules R-CTRL-INPUT-TYPE, R-CTRL-AUTOCOMPLETE, R-CTRL-BUTTON-TYPE and
  R-CTRL-FOCUS. Browser autofill is a data source even for an offline page:
  credentials fill only password-type fields, payment data only fields with
  matching autocomplete tokens.

  @rule:R-CTRL-INPUT-TYPE
  Scenario: Password, hidden, file and submit inputs become text inputs
    Given the generated HTML:
      """
      <input type="password"><input type="hidden" value="v"><input type="file"><input type="submit"><input type="number">
      """
    When every engine validates it
    Then "input" has attribute "type" equal to "text"
    And a change cites rule R-CTRL-INPUT-TYPE
    And all engines agree

  @rule:R-CTRL-INPUT-TYPE
  Scenario: Allowed input types are kept
    Given the generated HTML:
      """
      <input type="checkbox" checked>
      """
    When every engine validates it
    Then "input" has attribute "type" equal to "checkbox"
    And "input" has attribute "checked" equal to ""
    And all engines agree

  @rule:R-CTRL-AUTOCOMPLETE
  Scenario: Autocomplete is forced off on every control
    Given the generated HTML:
      """
      <input type="text" autocomplete="cc-number"><select autocomplete="on"><option>a</option></select><textarea autocomplete="on">t</textarea>
      """
    When every engine validates it
    Then "input" has attribute "autocomplete" equal to "off"
    And "select" has attribute "autocomplete" equal to "off"
    And "textarea" has attribute "autocomplete" equal to "off"
    And a change cites rule R-CTRL-AUTOCOMPLETE
    And all engines agree

  @rule:R-CTRL-AUTOCOMPLETE
  Scenario: Autocomplete is off even when not requested
    Given the generated HTML:
      """
      <input type="text">
      """
    When every engine validates it
    Then "input" has attribute "autocomplete" equal to "off"
    And all engines agree

  @rule:R-CTRL-BUTTON-TYPE
  Scenario: Buttons are always type=button
    Given the generated HTML:
      """
      <button type="submit">s</button><button type="reset">r</button>
      """
    When every engine validates it
    Then "button" has attribute "type" equal to "button"
    And a change cites rule R-CTRL-BUTTON-TYPE
    And all engines agree

  @rule:R-CTRL-BUTTON-TYPE
  Scenario: A button with no type is type=button
    Given the generated HTML:
      """
      <button>d</button>
      """
    When every engine validates it
    Then "button" has attribute "type" equal to "button"
    And all engines agree

  @rule:R-CTRL-FOCUS
  Scenario: Focus-stealing attributes are removed and tabindex is bounded
    Given the generated HTML:
      """
      <input type="text" autofocus accesskey="k" contenteditable draggable="true" tabindex="5"><p tabindex="0">t</p><p tabindex="-1">u</p>
      """
    When every engine validates it
    Then no attribute matching "autofocus|accesskey|contenteditable|draggable" remains
    And "input" has no attribute "tabindex"
    And "p" has attribute "tabindex" equal to "0"
    And a change cites rule R-CTRL-FOCUS
    And all engines agree
