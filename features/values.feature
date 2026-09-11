Feature: Attribute values conform to closed grammars
  Rules R-VAL-NUMBER, R-VAL-COLOR, R-VAL-PATH, R-VAL-TRANSFORM, R-VAL-KEYWORD
  and R-TEXT-CONTROL-BIDI. Values that do not fit the grammar are removed;
  values that fit are re-emitted canonically. The Lean grammar theorems in
  lean/Guard/Props cover these validators.

  @rule:R-VAL-NUMBER
  Scenario: Numbers are bounded, canonical and free of exponents
    Given the generated HTML:
      """
      <svg viewBox="0 0 100 50"><rect x="1e999" y="NaN" width="10.50" height="-5" rx="Infinity"></rect><circle r="99999999" cx="007" cy="2"></circle></svg>
      """
    When every engine validates it
    Then "rect" has attribute "width" equal to "10.5"
    And "rect" has no attribute "x"
    And "rect" has no attribute "y"
    And "rect" has no attribute "height"
    And "rect" has no attribute "rx"
    And "circle" has attribute "cx" equal to "7"
    And "circle" has no attribute "r"
    And "svg" has attribute "viewBox" equal to "0 0 100 50"
    And a change cites rule R-VAL-NUMBER
    And all engines agree

  @rule:R-VAL-COLOR
  Scenario: Paint values are solid colors only
    Given the generated HTML:
      """
      <svg><rect fill="#FF0000" stroke="rgb(1, 2, 3)" width="1" height="1"></rect><rect fill="url(#g)" stroke="expression(1)" width="1" height="1"></rect></svg>
      """
    When every engine validates it
    Then "rect" has attribute "fill" equal to "#FF0000"
    And "rect" has attribute "stroke" equal to "rgb(1, 2, 3)"
    And the text does not contain "url("
    And no attribute matching "^filter|mask|clip-path" remains
    And a change cites rule R-VAL-COLOR
    And all engines agree

  @rule:R-VAL-PATH
  Scenario: Path data is commands and canonical numbers only
    Given the generated HTML:
      """
      <svg><path d="M0 0L10-5.5.5Z"></path><path d="M 0 0 - L"></path><path d="M0 0 url(x)"></path></svg>
      """
    When every engine validates it
    Then "path" has attribute "d" equal to "M 0 0 L 10 -5.5 0.5 Z"
    And a change cites rule R-VAL-PATH
    And all engines agree

  @rule:R-VAL-TRANSFORM
  Scenario: Transforms are known functions with numeric arguments
    Given the generated HTML:
      """
      <svg><g transform="translate(1 2) scale(2)"></g><g transform="translate(1) , scale(2)"></g><g transform="url(x)"></g></svg>
      """
    When every engine validates it
    Then "g" has attribute "transform" equal to "translate(1 2) scale(2)"
    And a change cites rule R-VAL-TRANSFORM
    And all engines agree

  @rule:R-VAL-KEYWORD
  Scenario: Enumerated and identifier attributes are closed sets
    Given the generated HTML:
      """
      <p dir="RTL" role="alert" lang="en-US"><button data-action="go!" data-value="1">b</button></p><p dir="rtl" role="note">ok</p>
      """
    When every engine validates it
    Then "p" has no attribute "dir"
    And "p" has no attribute "role"
    And "p" has attribute "lang" equal to "en-US"
    And "button" has no attribute "data-action"
    And a change cites rule R-VAL-KEYWORD
    And all engines agree

  @rule:R-TEXT-CONTROL-BIDI
  Scenario: Bidi override characters are stripped from text and attributes
    Given the generated HTML:
      """
      <p title="a‮b">x‮y</p>
      """
    When every engine validates it
    Then "p" has attribute "title" equal to "ab"
    And the text "xy" is kept
    And the text does not contain "‮"
    And a change cites rule R-TEXT-CONTROL-BIDI
    And all engines agree
