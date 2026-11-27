// Queue runtime, emitted when a service `uses queue`. Two drivers, chosen by
// the environment the same way as kv/sql: without QUEUE_REDIS_URL everything
// is in-process (tests, local demo); with a redis binding the broker owns the
// messages and every replica may consume. Delivery is at-least-once: a
// failing body is retried up to the job's retry count, then moved to the
// dead letter queue where it can be read, not lost.
export const QUEUE_SOURCE = String.raw`// ---------- queue ----------

const QUEUE_REDIS_URL = String(process.env.QUEUE_REDIS_URL || '');
const QUEUE_PREFIX = 'arcod:q:';
const QUEUE_POLL_MS = 100;

// The body-facing effect. Memory driver appends in-process; the redis driver
// hands the message to the broker and answers whether it was accepted.
async function queuePublishDriver(topic, text) {
  return queueDriver.publish(topic, text);
}

// A message published for later waits in a due-time set instead of the list
// (B25). No timer runs in the service: the consumer promotes whatever is due
// before each receive, which is the poll it already makes.
async function queuePublishLaterDriver(topic, text, delayMs) {
  return queueDriver.later(topic, text, delayMs);
}

async function queueDeadDriver(topic) {
  return queueDriver.dead(topic);
}

// The body names a payload, not a stored line: the io layer finds the line that
// carries it and hands the text here, so both drivers agree on what a drop is.
async function queueDeadDropDriver(topic, text) {
  return queueDriver.removeDead(topic, text);
}

// Memory driver: one process owns both ends. The dead letter is a plain list
// per topic, which is also what the redis driver provides.
const MEM_QUEUES = new Map();
const MEM_DEAD = new Map();
// Delayed messages wait here until their due moment; the next receive on the
// topic moves them into MEM_QUEUES.
const MEM_LATER = new Map();
// B80.2: cancel requests in flight, keyed by the message id the publisher
// stamped. A set per topic, dropped when the consumer acks the message.
const MEM_CANCEL = new Map();

function promoteMemoryLater(topic) {
  const waiting = MEM_LATER.get(topic);
  if (!waiting || waiting.length === 0) return 0;
  const now = Date.now();
  const due = waiting.filter((item) => item.at <= now).sort((a, b) => a.at - b.at);
  if (due.length === 0) return 0;
  MEM_LATER.set(topic, waiting.filter((item) => item.at > now));
  const list = MEM_QUEUES.get(topic) || [];
  for (const item of due) list.push(item.text);
  MEM_QUEUES.set(topic, list);
  return due.length;
}

const memoryQueueDriver = {
  async publish(topic, text) {
    const list = MEM_QUEUES.get(topic) || [];
    list.push(text);
    MEM_QUEUES.set(topic, list);
    return true;
  },
  async later(topic, text, delayMs) {
    const list = MEM_LATER.get(topic) || [];
    list.push({ at: Date.now() + Math.max(0, Number(delayMs) || 0), text });
    MEM_LATER.set(topic, list);
    return true;
  },
  async receive(topic) {
    promoteMemoryLater(topic);
    const list = MEM_QUEUES.get(topic);
    if (!list || list.length === 0) return null;
    return list.shift();
  },
  async requeue(topic, text) {
    const list = MEM_QUEUES.get(topic) || [];
    list.unshift(text);
    MEM_QUEUES.set(topic, list);
    return true;
  },
  async dead(topic) {
    return MEM_DEAD.get(topic) || [];
  },
  async removeDead(topic, text) {
    const list = MEM_DEAD.get(topic) || [];
    const index = list.indexOf(text);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  },
  async cancel(topic, id) {
    const set = MEM_CANCEL.get(topic) || new Set();
    set.add(String(id));
    MEM_CANCEL.set(topic, set);
    return true;
  },
  async isCancelled(topic, id) {
    const set = MEM_CANCEL.get(topic);
    return !!(set && set.has(String(id)));
  },
  async forgetCancel(topic, id) {
    const set = MEM_CANCEL.get(topic);
    if (set) set.delete(String(id));
    return true;
  },
  async toDead(topic, text) {
    const list = MEM_DEAD.get(topic) || [];
    list.push(text);
    MEM_DEAD.set(topic, list);
    return true;
  },
};

// Redis driver over a minimal RESP client (no packages, same rule as the
// store). Lists, not streams: LPOP/RPUSH cover at-least-once with retry and
// a dead letter without server-side consumer groups.
function createRedisQueueDriver(url) {
  const match = /^redis:\/\/([^:/]+)(?::([0-9]+))?$/.exec(url);
  const host = match ? match[1] : 'redis';
  const port = match && match[2] ? Number(match[2]) : 6379;
  const state = { socket: null, buffer: Buffer.alloc(0), pending: [], connecting: null };
  // A broker that accepts the connection but never answers is the same outage
  // as a restarted one, only quieter: without a deadline the consumer waits
  // forever and never reaches its retry path.
  const timeoutMs = Number(process.env.ARCod_QUEUE_TIMEOUT_MS || process.env.ARCod_STORE_TIMEOUT_MS || 5000);

  function parseReply(buf, offset) {
    if (offset >= buf.length) return null;
    const type = String.fromCharCode(buf[offset]);
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const line = buf.toString('utf8', offset + 1, lineEnd);
    if (type === '+' || type === '-') return { value: type === '-' ? new Error(line) : line, next: lineEnd + 2 };
    if (type === ':') return { value: Number(line), next: lineEnd + 2 };
    if (type === '$') {
      const len = Number(line);
      if (len === -1) return { value: null, next: lineEnd + 2 };
      const start = lineEnd + 2;
      if (buf.length < start + len + 2) return null;
      return { value: buf.toString('utf8', start, start + len), next: start + len + 2 };
    }
    if (type === '*') {
      // LRANGE and friends answer with an array; a nested array or a null
      // element ($-1) is legal RESP, so the walk is recursive.
      const count = Number(line);
      if (count === -1) return { value: null, next: lineEnd + 2 };
      const values = [];
      let next = lineEnd + 2;
      for (let index = 0; index < count; index++) {
        const item = parseReply(buf, next);
        if (!item) return null;
        values.push(item.value);
        next = item.next;
      }
      return { value: values, next };
    }
    throw new Error('unexpected RESP type: ' + type);
  }

  // A broker restart must not leave a caller waiting forever: every command
  // in flight gets the failure, and the next command opens a fresh socket.
  function failPending(error) {
    const waiting = state.pending;
    state.pending = [];
    for (const item of waiting) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(error);
    }
  }

  function onData(chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      let parsed;
      try {
        parsed = parseReply(state.buffer, 0);
      } catch (error) {
        // Corrupt stream: nobody can resynchronise it, so fail the callers
        // and drop the connection instead of throwing inside a socket event.
        failPending(error);
        if (state.socket) state.socket.destroy();
        return;
      }
      if (!parsed) break;
      state.buffer = state.buffer.subarray(parsed.next);
      const pending = state.pending.shift();
      if (!pending) continue;
      if (pending.timer) clearTimeout(pending.timer);
      if (parsed.value instanceof Error) pending.reject(parsed.value);
      else pending.resolve(parsed.value);
    }
  }

  function connect() {
    if (state.socket && !state.socket.destroyed) return Promise.resolve();
    if (state.connecting) return state.connecting;
    // A half-written reply from the previous connection means nothing on the
    // new one.
    state.buffer = Buffer.alloc(0);
    state.connecting = new Promise((resolve, reject) => {
      let timer = null;
      const stopTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const socket = net.createConnection({ host, port }, () => {
        stopTimer();
        state.connecting = null;
        resolve();
      });
      // A dropped SYN would otherwise hang the consumer for the OS timeout.
      timer = setTimeout(() => {
        timer = null;
        state.connecting = null;
        if (state.socket === socket) state.socket = null;
        const error = new Error('redis connect timeout');
        failPending(error);
        socket.destroy();
        reject(error);
      }, timeoutMs);
      socket.on('data', onData);
      socket.on('error', (err) => {
        stopTimer();
        // A socket a reconnect already replaced is not this connection's:
        // failing the current pending calls here would abort healthy work.
        if (state.socket !== socket) return;
        state.connecting = null;
        state.socket = null;
        failPending(err);
        reject(err);
      });
      socket.on('close', () => {
        stopTimer();
        if (state.socket !== socket) return;
        state.socket = null;
        failPending(new Error('redis connection closed'));
      });
      state.socket = socket;
    });
    return state.connecting;
  }

  async function command(...args) {
    await connect();
    return new Promise((resolve, reject) => {
      const item = { resolve, reject };
      // Replies are positional: a call that timed out drops the stream with
      // it, so its late answer cannot be handed to the next caller.
      item.timer = setTimeout(() => {
        const index = state.pending.indexOf(item);
        if (index !== -1) state.pending.splice(index, 1);
        if (state.socket) state.socket.destroy();
        reject(new Error('redis command timeout'));
      }, timeoutMs);
      state.pending.push(item);
      const parts = ['*' + args.length + '\r\n'];
      for (const arg of args) {
        const value = String(arg);
        parts.push('$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n');
      }
      state.socket.write(parts.join(''));
    });
  }

  // Sorted-set members are unique, so two identical payloads must not share
  // one: the nonce keeps both messages and is stripped on promotion.
  let laterSeq = 0;

  async function promoteLater(topic) {
    const key = QUEUE_PREFIX + topic + ':later';
    const due = await command('ZRANGEBYSCORE', key, '-inf', String(Date.now()), 'LIMIT', '0', '100');
    if (!Array.isArray(due) || due.length === 0) return 0;
    let moved = 0;
    for (const member of due.map(String)) {
      // ZREM is the claim: two replicas polling one topic race here and only
      // the one that removed the member enqueues it, so a delayed message is
      // delivered once (retry and the dead letter keep at-least-once on top).
      if (Number(await command('ZREM', key, member)) > 0) {
        await command('RPUSH', QUEUE_PREFIX + topic, member.slice(member.indexOf('\n') + 1));
        moved += 1;
      }
    }
    return moved;
  }

  return {
    async publish(topic, text) {
      await command('RPUSH', QUEUE_PREFIX + topic, text);
      return true;
    },
    async later(topic, text, delayMs) {
      const nonce = Date.now().toString(36) + '-' + (laterSeq++) + '-' + Math.random().toString(36).slice(2, 8);
      await command('ZADD', QUEUE_PREFIX + topic + ':later', String(Date.now() + Math.max(0, Number(delayMs) || 0)), nonce + '\n' + text);
      return true;
    },
    async receive(topic) {
      await promoteLater(topic);
      const value = await command('LPOP', QUEUE_PREFIX + topic);
      return value == null ? null : String(value);
    },
    async requeue(topic, text) {
      await command('LPUSH', QUEUE_PREFIX + topic, text);
      return true;
    },
    async dead(topic) {
      const key = QUEUE_PREFIX + topic + ':dead';
      const length = Number(await command('LLEN', key));
      if (length === 0) return [];
      const values = await command('LRANGE', key, '0', String(length - 1));
      return Array.isArray(values) ? values.map(String) : [];
    },
    async cancel(topic, id) {
      // A flag with a ttl, not state: a cancel for a message another replica
      // already finished expires instead of growing the keyspace.
      await command('SET', QUEUE_PREFIX + topic + ':cancel:' + id, '1', 'EX', '300');
      return true;
    },
    async isCancelled(topic, id) {
      return Number(await command('EXISTS', QUEUE_PREFIX + topic + ':cancel:' + id)) === 1;
    },
    async forgetCancel(topic, id) {
      await command('DEL', QUEUE_PREFIX + topic + ':cancel:' + id);
      return true;
    },
    async toDead(topic, text) {
      await command('RPUSH', QUEUE_PREFIX + topic + ':dead', text);
      return true;
    },
    async removeDead(topic, text) {
      // LREM counts from the head and stops after one match: the same payload
      // published twice keeps its second dead entry.
      const removed = Number(await command('LREM', QUEUE_PREFIX + topic + ':dead', '1', text));
      return removed > 0;
    },
  };
}

const queueDriver = QUEUE_REDIS_URL ? createRedisQueueDriver(QUEUE_REDIS_URL) : memoryQueueDriver;
`;

// Consumer wiring, emitted per service: one entry per queue-backed job. The
// handler names refer to the bodies emitted next to the http handlers; they
// are module-scope functions, so the table binds them directly (globalThis
// does not see module declarations).
export function consumerSource(consumers: Array<{ topic: string; handler: string; params: string[]; retry: number; declaresResult?: boolean }>): string {
  if (consumers.length === 0) {
    // No queue-backed jobs, but a service may still use queue for publishing
    // (the outbox). Emit the lifecycle scaffolding so startConsumers and the
    // shutdown hooks always exist.
    return String.raw`
let consumersStopped = false;
let consumersDrained = Promise.resolve();
function startConsumers() {}
`;
  }
  const table = consumers
    .map((item) => [
      '  {',
      '    topic: ' + JSON.stringify(item.topic) + ',',
      '    fn: ' + item.handler + ',',
      '    params: ' + JSON.stringify(item.params) + ',',
      '    retry: ' + item.retry + ',',
      '    declaresResult: ' + (item.declaresResult ? 'true' : 'false') + ',',
      '  }',
    ].join('\n'))
    .join(',\n');
  return String.raw`
// Consumers come from the model: job <Name> { on: events.topic, retry: n }.
// The lifecycle (start with the service, poll, ack by completion, nack by
// requeue, dead letter after the retry budget) is runtime code, not body
// code — a body is a plain function of the message.
const CONSUMERS = [
` + table + String.raw`
];

// Retry backoff (B25): a failed attempt waits 250ms, 500ms, 1s, ... before
// the requeue, capped at 30s. Requeueing at once turned one broken downstream
// into a hot loop that burned the retry budget in milliseconds and filled the
// log; the cap keeps a long outage cheap. Deterministic, so tests can read it.
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 30000;

function retryDelayMs(attempts) {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
}

// B80.2: a cancel request travels through the broker, keyed by the id the
// publisher stamped on the message, so it reaches a job running in another
// replica and a body already inside a remote call. The watch is one flag read
// per poll while the body runs, and stops with it.
const CANCEL_POLL_MS = 100;

function watchCancellation(spec, id, controller) {
  let stopped = false;
  const tick = () => {
    if (stopped || controller.signal.aborted) return;
    queueDriver.isCancelled(spec.topic, id).then((flagged) => {
      if (flagged) { if (!stopped) controller.abort(); return; }
      if (!stopped) setTimeout(tick, CANCEL_POLL_MS);
    }).catch(() => {
      // A broker hiccup is not a cancel request: the job keeps running.
      if (!stopped) setTimeout(tick, CANCEL_POLL_MS);
    });
  };
  setTimeout(tick, CANCEL_POLL_MS);
  return () => { stopped = true; };
}

let consumersStopped = false;
let consumersDrained = Promise.resolve();

function consumerInput(spec, payload) {
  if (spec.params.length === 0) return {};
  if (spec.params.length === 1) {
    const name = spec.params[0];
    // A publisher usually sends the object the body wrote, so the single
    // parameter is the field with that name. A bare scalar is the parameter
    // itself, and an object without that key stays whole (fallback).
    const named = payload && typeof payload === 'object' && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, name);
    return { [name]: named ? payload[name] : payload };
  }
  const values = payload && typeof payload === 'object' ? payload : { [spec.params[0]]: payload };
  const input = {};
  // Own keys only: a parameter named toString is absent from a payload that
  // never carried it, while the in operator answers with the inherited
  // function and hands the body a value the publisher never sent.
  for (const name of spec.params) input[name] = Object.hasOwn(values, name) ? values[name] : null;
  return input;
}

async function runConsumer(spec) {
  let receiveFailures = 0;
  while (!consumersStopped) {
    let raw;
    try {
      raw = await queueDriver.receive(spec.topic);
      if (receiveFailures > 0) {
        console.warn('[arcod] queue ' + spec.topic + ': receive recovered after ' + receiveFailures + ' failed attempt(s)');
        receiveFailures = 0;
      }
    } catch (error) {
      // A broker restart fails an in-flight LPOP. Unhandled, that rejection
      // ended the loop and the service kept serving HTTP without consumers;
      // now the loop backs off and tries again. One line at the start of an
      // outage and one every 300 polls (~30s) keep a long outage readable.
      receiveFailures += 1;
      if (receiveFailures === 1 || receiveFailures % 300 === 0) {
        console.error('[arcod] queue ' + spec.topic + ': receive failed (' + receiveFailures + ' in a row): ' + String((error && error.message) || error) + ', retrying');
      }
      await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS));
      continue;
    }
    if (raw == null) {
      await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS));
      continue;
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // The topic name and a fixed phrase only: the raw message is user data.
      console.error('[arcod] queue ' + spec.topic + ': unreadable message, moved to dead letter');
      try {
        await queueDriver.toDead(spec.topic, JSON.stringify({ payload: null, attempts: 0, lastError: 'unreadable message' }));
      } catch (storeError) {
        console.error('[arcod] queue ' + spec.topic + ': could not record an unreadable message: ' + String((storeError && storeError.message) || storeError));
      }
      continue;
    }
    // B80.2: the job owns a controller. The broker flag is polled while the
    // body runs, so a cancel request reaches a body that is already inside an
    // external call; io.signal is what the body hands to io.remote.
    const controller = new AbortController();
    const messageId = envelope.id == null ? null : String(envelope.id);
    const stopWatch = messageId && typeof queueDriver.isCancelled === 'function'
      ? watchCancellation(spec, messageId, controller)
      : null;
    try {
      const out = await spec.fn(consumerInput(spec, envelope.payload), makeIo({ headers: {}, signal: controller.signal, messageId }));
      if (out && out.error) throw new Error('consumer returned error: ' + out.error);
      // A job that declares a result type promises one: returning nothing
      // means the body fell through (io.fetch returned null) and the message
      // would be acked with the work lost, so retry/DLQ must see it. A bare
      // job has no result to promise: finishing is the success signal, and a
      // side effect followed by a bare return must not repeat on retry (B114).
      if (spec.declaresResult && (out === null || out === undefined)) {
        throw new Error('consumer returned no result for its input');
      }
    } catch (error) {
      // A cancelled job is finished, not failed: the message stays acked
      // (it was popped by receive), no retry and no dead letter follow, and
      // one line records the reason without the payload (B80.2).
      if (error && error.kind === 'cancelled') {
        console.warn('[arcod] queue ' + spec.topic + ': job cancelled, message acknowledged');
        continue;
      }
      const attempts = Number(envelope.attempts || 0) + 1;
      const maxAttempts = spec.retry + 1;
      const lastError = String((error && error.message) || error);
      try {
        if (attempts > spec.retry) {
          // One line, no payload: the reason a job disappeared is in the service log.
          console.error('[arcod] queue ' + spec.topic + ': attempt ' + attempts + '/' + maxAttempts + ' failed: ' + lastError + ', moved to dead letter');
          await queueDriver.toDead(spec.topic, JSON.stringify({
            payload: envelope.payload,
            attempts,
            lastError,
          }));
        } else {
          const delay = retryDelayMs(attempts);
          console.warn('[arcod] queue ' + spec.topic + ': attempt ' + attempts + '/' + maxAttempts + ' failed: ' + lastError + ', requeued in ' + delay + 'ms');
          await new Promise((resolve) => setTimeout(resolve, delay));
          await queueDriver.requeue(spec.topic, JSON.stringify({ payload: envelope.payload, attempts, id: envelope.id }));
        }
      } catch (storeError) {
        // The broker is down at the worst moment: the attempt could not be
        // recorded, but the service must keep consuming once it is back.
        console.error('[arcod] queue ' + spec.topic + ': could not record a failed attempt: ' + String((storeError && storeError.message) || storeError));
      }
    } finally {
      if (stopWatch) stopWatch();
      // The id is spent: a cancel flag left behind would abort a future
      // message only if the broker reused the id, and no driver does.
      if (messageId && typeof queueDriver.forgetCancel === 'function') {
        queueDriver.forgetCancel(spec.topic, messageId).catch(() => {});
      }
    }
  }
}

function startConsumers() {
  const running = CONSUMERS.filter((spec) => typeof spec.fn === 'function');
  if (running.length === 0) return;
  consumersDrained = Promise.all(running.map((spec) => runConsumer(spec)));
}
`;
}

// Shutdown replacement: consumers finish the message in flight (ack or
// dead-letter), then the http server drains and the process exits.
export const QUEUE_SHUTDOWN = String.raw`for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    consumersStopped = true;
    server.close(() => {
      Promise.resolve(consumersDrained).finally(() => process.exit(0));
    });
  });
}`;

// The sql+queue variant also drains the outbox dispatcher.
export const OUTBOX_SHUTDOWN = String.raw`for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    consumersStopped = true;
    outboxStopped = true;
    server.close(() => {
      Promise.all([Promise.resolve(consumersDrained), Promise.resolve(outboxDrained)]).finally(() => process.exit(0));
    });
  });
}`;

// Outbox dispatcher, emitted only on the sql driver with a queue capability.
// The body writes the event into arcod_outbox inside its transaction; this
// loop relays committed rows to the broker and marks them published. Runs
// alongside consumers, so a replica that dies between commit and publish
// finds the row still pending on restart.
// The dispatcher is emitted with the service, so it has to construct the same
// client the service does: a postgres build must not reference SqlStore.
export function outboxSource(dialect: 'mysql' | 'postgres' = 'mysql'): string {
  if (dialect !== 'postgres') return OUTBOX_SOURCE;
  // Swap the constructor, not the text around it: the dispatcher must build the
  // same client the emitted service does.
  return OUTBOX_SOURCE.replace(
    /new SqlStore\(process\.env\.DATABASE_URL[^)]*\)/,
    "new PgStore(process.env.DATABASE_URL || 'postgres://arcod:arcod@postgres:5432/arcod')",
  );
}

export const OUTBOX_SOURCE = String.raw`// ---------- outbox dispatcher ----------

let outboxStopped = false;
let outboxDrained = Promise.resolve();

// The dispatcher owns its own connection: the request path and the relay must
// not interleave on the single store socket, or the RESP stream corrupts.
const outboxStore = process.env.SQL_DRIVER === 'memory'
  ? store
  : new SqlStore(process.env.DATABASE_URL || 'mysql://arcod:***@mysql:3306/arcod');

// A store outage or a dead broker must not write ten lines a second: the
// dispatcher sweeps continuously, so the log is throttled to one line per
// kind per 30 seconds. The first failure always gets through.
let lastOutboxLogAt = 0;
function outboxLog(kind, error) {
  const now = Date.now();
  if (now - lastOutboxLogAt < 30000) return;
  lastOutboxLogAt = now;
  console.error('outbox ' + kind + ' failed:', error && error.message ? error.message : error);
}

async function runOutboxDispatcher() {
  while (!outboxStopped) {
    let rows = [];
    try {
      rows = await outboxStore.outboxPending(20);
    } catch (error) {
      outboxLog('poll', error);
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (rows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    for (const row of rows) {
      try {
        await queuePublishDriver(String(row.topic), String(row.payload));
        await outboxStore.outboxMark(String(row.id));
      } catch (error) {
        // Leave the row pending; the next sweep retries it (at-least-once).
        outboxLog('publish', error);
      }
    }
  }
}

function startOutboxDispatcher() {
  outboxDrained = runOutboxDispatcher();
}
`;
