// Cross-origin module payload that a blob: Worker dynamically imports.
// Question 3: does await import() inside a blob: Worker work when the
// inherited policy is nonce-based?
self.postMessage({ type: "payload-imported", href: String(self.location.href).slice(0, 160) });
