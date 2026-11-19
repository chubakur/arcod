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

async function queueDeadDriver(topic) {
  return queueDriver.dead(topic);
}

// Memory driver: one process owns both ends. The dead letter is a plain list
// per topic, which is also what the redis driver provides.
const MEM_QUEUES = new Map();
const MEM_DEAD = new Map();

const memoryQueueDriver = {
  async publish(topic, text) {
    const list = MEM_QUEUES.get(topic) || [];
    list.push(text);
    MEM_QUEUES.set(topic, list);
    return true;
  },
  async receive(topic) {
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
    for (const item of waiting) item.reject(error);
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
      const socket = net.createConnection({ host, port }, () => {
        state.connecting = null;
        resolve();
      });
      socket.on('data', onData);
      socket.on('error', (err) => {
        state.connecting = null;
        failPending(err);
        if (state.socket === socket) state.socket = null;
        reject(err);
      });
      socket.on('close', () => {
        if (state.socket === socket) state.socket = null;
        failPending(new Error('redis connection closed'));
      });
      state.socket = socket;
    });
    return state.connecting;
  }

  async function command(...args) {
    await connect();
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject });
      const parts = ['*' + args.length + '\r\n'];
      for (const arg of args) {
        const value = String(arg);
        parts.push('$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n');
      }
      state.socket.write(parts.join(''));
    });
  }

  return {
    async publish(topic, text) {
      await command('RPUSH', QUEUE_PREFIX + topic, text);
      return true;
    },
    async receive(topic) {
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
    async toDead(topic, text) {
      await command('RPUSH', QUEUE_PREFIX + topic + ':dead', text);
      return true;
    },
  };
}

const queueDriver = QUEUE_REDIS_URL ? createRedisQueueDriver(QUEUE_REDIS_URL) : memoryQueueDriver;
`;

// Consumer wiring, emitted per service: one entry per queue-backed job. The
// handler names refer to the bodies emitted next to the http handlers; they
// are module-scope functions, so the table binds them directly (globalThis
// does not see module declarations).
export function consumerSource(consumers: Array<{ topic: string; handler: string; params: string[]; retry: number }>): string {
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
  for (const name of spec.params) input[name] = name in values ? values[name] : null;
  return input;
}

async function runConsumer(spec) {
  while (!consumersStopped) {
    const raw = await queueDriver.receive(spec.topic);
    if (raw == null) {
      await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS));
      continue;
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      await queueDriver.toDead(spec.topic, JSON.stringify({ payload: null, attempts: 0, lastError: 'unreadable message' }));
      continue;
    }
    try {
      const out = await spec.fn(consumerInput(spec, envelope.payload), makeIo({ headers: {} }));
      if (out && out.error) throw new Error('consumer returned error: ' + out.error);
      // A job with input that returns nothing did nothing: io.fetch returned
      // null, the body fell through, and the message would be acked with the
      // work lost. Treat it as a failed attempt so retry/DLQ sees it.
      if (spec.params.length > 0 && (out === null || out === undefined)) {
        throw new Error('consumer returned no result for its input');
      }
    } catch (error) {
      const attempts = Number(envelope.attempts || 0) + 1;
      if (attempts > spec.retry) {
        await queueDriver.toDead(spec.topic, JSON.stringify({
          payload: envelope.payload,
          attempts,
          lastError: String((error && error.message) || error),
        }));
      } else {
        await queueDriver.requeue(spec.topic, JSON.stringify({ payload: envelope.payload, attempts }));
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

async function runOutboxDispatcher() {
  while (!outboxStopped) {
    let rows = [];
    try {
      rows = await outboxStore.outboxPending(20);
    } catch (error) {
      console.error('outbox poll failed:', error && error.message ? error.message : error);
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
        console.error('outbox publish failed:', error && error.message ? error.message : error);
      }
    }
  }
}

function startOutboxDispatcher() {
  outboxDrained = runOutboxDispatcher();
}
`;
