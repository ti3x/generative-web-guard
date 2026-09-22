// Virtual timers and FIFO transports. Only the head of each transport can be
// selected, so a schedule cannot invent a browser-impossible per-port reorder.
export function scheduler() {
  let now = 0, next = 0;
  const timers = new Map(), queues = new Map(), ports = [], messages = [];
  const queue = (name, run, data) => {
    if (!queues.has(name)) queues.set(name, []);
    queues.get(name).push({ run, data });
  };
  const clock = {
    setTimeout(fn, delay = 0) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  class Port {
    constructor() { this.id = ++next; this.closed = false; this.inbox = []; ports.push(this); }
    start() {}
    get onmessage() { return this.handler; }
    set onmessage(fn) { this.handler = fn; this.schedule(); }
    schedule() {
      if (this.scheduled || !this.handler || !this.inbox.length || this.closed) return;
      this.scheduled = true;
      const item = this.inbox[0];
      queue(`port-${this.id}`, () => {
        this.scheduled = false;
        if (this.closed || !this.handler) return;
        this.inbox.shift();
        messages.push({ phase: "delivered", data: structuredClone(item) });
        this.handler({ data: item });
        this.schedule();
      }, item);
    }
    postMessage(data) {
      if (this.closed) throw new Error("post after port close");
      if (this.peer.closed) return;
      const item = structuredClone(data);
      messages.push({ phase: "sent", data: structuredClone(item) });
      this.peer.inbox.push(item); this.peer.schedule();
    }
    close() { this.closed = true; this.inbox.length = 0; this.handler = null; }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
  }
  const originals = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, MessageChannel: globalThis.MessageChannel, now: Date.now };
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  globalThis.MessageChannel = Channel;
  Date.now = () => now;
  return {
    queue, ports, messages,
    async microtasks() { for (let i = 0; i < 16; i++) await Promise.resolve(); },
    async deliver(choice = 0) {
      const active = [...queues.values()].filter(q => q.length);
      if (!active.length) return false;
      active[choice % active.length].shift().run();
      await this.microtasks(); return true;
    },
    async advance(ms) {
      const end = now + ms;
      for (let steps = 0; steps < 10000; steps++) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) { now = end; await this.microtasks(); return; }
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await this.microtasks();
      }
      throw new Error("virtual timer livelock");
    },
    async drain() { for (let i = 0; i < 10000; i++) { if (!await this.deliver()) return; } throw new Error("transport livelock"); },
    corruptAck() {
      for (const q of queues.values()) {
        const data = q[0]?.data;
        if (data?.kind === "frame/rendered") { data.requestId += 999; return; }
      }
    },
    get timerCount() { return timers.size; },
    restore() { Object.assign(globalThis, { setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout, MessageChannel: originals.MessageChannel }); Date.now = originals.now; },
  };
}
