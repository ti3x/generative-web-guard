Feature: Generated JavaScript runs isolated with bounded resources
  Rules R-RT-ISOLATION, R-RT-LIMITS, R-RT-FROZEN-DATA and R-GATE-INTERFACE.
  The program runs inside QuickJS compiled to WebAssembly; state crosses the
  boundary only as JSON text and the view only as a string.

  @rule:R-RT-ISOLATION
  Scenario: No host capability is visible to the program
    Given the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view() {
        const names = ["fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "importScripts",
          "require", "process", "window", "document", "std", "os", "postMessage", "Worker", "navigator", "localStorage"];
        return names.filter((n) => typeof globalThis[n] !== "undefined").join(",");
      }
      """
    When the runtime initializes
    Then the view is ""

  @rule:R-RT-ISOLATION
  Scenario: State crosses the boundary as JSON and steps compose
    Given the program:
      """
      const initialState = { count: 0, items: ["b", "a"] };
      function update(state, event) {
        if (event.action === "increment") return { ...state, count: state.count + 1 };
        if (event.action === "sort") return { ...state, items: [...state.items].sort() };
        return state;
      }
      function view(state) {
        return "<p>Count: " + state.count + "</p><ul>" + state.items.map((i) => "<li>" + i + "</li>").join("") + "</ul>";
      }
      """
    When the runtime initializes
    Then the view is "<p>Count: 0</p><ul><li>b</li><li>a</li></ul>"
    When the runtime steps with event "increment"
    And the runtime steps with event "sort"
    Then the view is "<p>Count: 1</p><ul><li>a</li><li>b</li></ul>"

  @rule:R-RT-ISOLATION
  Scenario: Tampering with JSON inside the program does not change how results leave
    Given the program:
      """
      JSON.stringify = () => "\"pwned\"";
      JSON.parse = () => ({ count: 999 });
      const initialState = { count: 1 };
      function update(s, e) { return { count: s.count + 1 }; }
      function view(s) { return "c=" + s.count; }
      """
    When the runtime initializes
    Then the view is "c=1"
    When the runtime steps with event "x"
    Then the view is "c=2"

  @rule:R-RT-LIMITS
  Scenario: An infinite loop is interrupted by the deadline
    Given a runtime step budget of 50 ms
    And the program:
      """
      const initialState = {};
      function update(s) { for (;;) {} }
      function view(s) { return "x"; }
      """
    When the runtime initializes
    And the runtime steps with event "go"
    Then the step fails with "interrupted"

  @rule:R-RT-LIMITS
  Scenario: Runaway allocation hits the memory limit
    Given a runtime memory limit of 4 MiB
    And the program:
      """
      const initialState = {};
      function update(s) { const a = []; for (;;) a.push(new Array(1024).fill("x")); }
      function view(s) { return "x"; }
      """
    When the runtime initializes
    And the runtime steps with event "go"
    Then the step fails

  @rule:R-RT-LIMITS
  Scenario: Deep recursion hits the stack limit
    Given a runtime stack limit of 256 KiB
    And the program:
      """
      const initialState = {};
      function update(s) { return update(s); }
      function view(s) { return "x"; }
      """
    When the runtime initializes
    And the runtime steps with event "go"
    Then the step fails with "stack"

  @rule:R-RT-LIMITS
  Scenario: An oversized view is rejected
    Given a view size limit of 100 characters
    And the program:
      """
      const initialState = { big: false };
      function update(s) { return { big: true }; }
      function view(s) { return s.big ? "x".repeat(1000) : "ok"; }
      """
    When the runtime initializes
    Then the view is "ok"
    When the runtime steps with event "go"
    Then the step fails with "view too large"

  @rule:R-RT-LIMITS
  Scenario: A non-string view is rejected
    Given the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view(s) { return { toString() { return "obj"; } }; }
      """
    When the runtime initializes
    Then the step fails with "view must return a string"

  @rule:R-RT-LIMITS
  Scenario: The host watchdog kills a hung worker and marks the runtime dead
    Given the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view(s) { return "x"; }
      """
    When the controller loads the program on a hung worker with a 50 ms watchdog
    Then the runtime is dead with reason matching "watchdog"
    And the worker was terminated

  @rule:R-RT-LIMITS
  Scenario: The controller bounds the event queue
    Given the controller queue holds at most 2 events
    And the program:
      """
      const initialState = { count: 0 };
      function update(state, event) { return { count: state.count + 1 }; }
      function view(state) { return "Count: " + state.count; }
      """
    When the controller loads the program
    And the controller receives 5 increment events at once
    Then at least 2 events were rejected as queue full

  @rule:R-RT-FROZEN-DATA
  Scenario: Host data is a frozen global the program can read but not change
    Given host data:
      """
      { "rows": [ { "v": 1 }, { "v": 2 }, { "v": 3 } ] }
      """
    And the program:
      """
      const initialState = { n: data.rows.length };
      function update(s, e) {
        let threw = false;
        try { data.rows.push({ v: 99 }); } catch (err) { threw = true; }
        data.rows[0].v = -1;
        data = null;
        return { n: data.rows.length, first: data.rows[0].v, sum: data.rows.reduce((a, r) => a + r.v, 0), threw };
      }
      function view(s) { return JSON.stringify(s); }
      """
    When the runtime initializes
    Then the view is "{\"n\":3}"
    When the runtime steps with event "x"
    Then the view is "{\"n\":3,\"first\":1,\"sum\":6,\"threw\":true}"

  @rule:R-RT-FROZEN-DATA
  Scenario: Without host data the global is null
    Given the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view() { return String(data); }
      """
    When the runtime initializes
    Then the view is "null"

  @rule:R-RT-FROZEN-DATA
  Scenario: Oversized host data is refused
    Given a host data size limit of 10 characters
    And host data:
      """
      { "big": "xxxxxxxxxx" }
      """
    And the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view() { return ""; }
      """
    When the runtime loads the program
    Then loading fails with "size limit"

  @rule:R-RT-FROZEN-DATA
  Scenario: The controller serializes host data for the program
    Given host data:
      """
      [ { "region": "North" }, { "region": "South" } ]
      """
    And the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view() { return "rows=" + data.length + " first=" + data[0].region; }
      """
    When the controller loads the program
    Then the view is "rows=2 first=North"

  @rule:R-GATE-INTERFACE
  Scenario: The reference interface is accepted
    Given the program:
      """
      const initialState = { count: 0 };
      function update(state, event) {
        if (event.action === "increment") return { ...state, count: state.count + 1 };
        return state;
      }
      function view(state) { return "<p>" + state.count + "</p>"; }
      """
    When the gate checks the program
    Then the gate accepts it

  @rule:R-GATE-INTERFACE
  Scenario: A program missing the interface is rejected
    Given the program:
      """
      const x = 1;
      """
    When the gate checks the program
    Then the gate rejects it with "missing"

  @rule:R-GATE-INTERFACE
  Scenario: Unsupported constructs are rejected with locations
    Given the program:
      """
      const initialState = {};
      function update(s) { return s; }
      function view() { return ""; }
      const m = import("y");
      async function f() { await 1; }
      function* g() { yield 1; }
      const h = eval("1");
      const i = new Function("return 1");
      fetch("https://x");
      window.location = "x";
      """
    When the gate checks the program
    Then the gate rejects it with "module-syntax"
    And the gate rejects it with "async"
    And the gate rejects it with "generator"
    And the gate rejects it with "denied-identifier"
    And the gate rejects it with "dynamic-code"
    And every gate rejection except syntax carries a location

  @rule:R-GATE-INTERFACE
  Scenario: Interface violations at load time are errors with messages
    Given the program:
      """
      const initialState = 1;
      """
    When the runtime loads the program
    Then loading fails with "update must be a function"
