// A transactional op owns the service's store for its whole body: the sql
// store is one connection, so a second `BEGIN` would land inside the first
// transaction, a duplicate-key INSERT would abort it, and the other request's
// `ROLLBACK` would discard the winner's row (issue #57).
//
// A transaction therefore takes the gate exclusively and every other request
// takes it shared: ordinary requests still overlap with each other, but none
// runs while a transaction is open (a read on the same connection would see
// uncommitted rows). Variant (b) of B110, kept in one place so both dialects
// and any future store inherit it.
export const TX_GATE_SOURCE = `function createTxGate() {
  let readers = 0;
  let writer = false;
  const waiters = [];
  function settle() {
    while (waiters.length > 0) {
      const head = waiters[0];
      if (head.exclusive ? (writer || readers > 0) : writer) return;
      waiters.shift();
      if (head.exclusive) writer = true;
      else readers += 1;
      head.resolve();
    }
  }
  function acquire(exclusive) {
    return new Promise((resolve) => { waiters.push({ exclusive, resolve }); settle(); });
  }
  function release(exclusive) {
    if (exclusive) writer = false;
    else readers -= 1;
    settle();
  }
  return {
    // Ordinary work: waits only while a transaction is open.
    async share(fn) {
      await acquire(false);
      try { return await fn(); } finally { release(false); }
    },
    // A transactional body: nothing else touches the store until it ends.
    async hold(fn) {
      await acquire(true);
      try { return await fn(); } finally { release(true); }
    },
  };
}`;
