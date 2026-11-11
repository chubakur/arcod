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
    throw new Error('unexpected RESP type: ' + type);
  }

  function onData(chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      const parsed = parseReply(state.buffer, 0);
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
    state.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        state.connecting = null;
        resolve();
      });
      socket.on('data', onData);
      socket.on('error', (err) => { state.connecting = null; reject(err); });
      socket.on('close', () => { state.socket = null; });
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
  if (consumers.length === 0) return '';
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
  if (spec.params.length === 1) return { [spec.params[0]]: payload };
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
