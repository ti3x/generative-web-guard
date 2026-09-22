// Required interaction-program interface. `data` is null unless --data is
// supplied; when supplied it is JSON data frozen by the QuickJS host.
const initialState = { visits: 1 };

function update(state, event) {
  return event.action === "visit" ? { visits: state.visits + 1 } : state;
}

function view(state) {
  // The script and on* attribute demonstrate that the emitted view still has
  // to pass the markup policy; they are removed from the resulting HTML.
  return `<h1>${data ? data.title : "Hello"}</h1>` +
    `<p>Visits: ${state.visits}</p><p onclick="bad()">Kept text</p>` +
    `<script>alert("not rendered")</script>`;
}
