// B25: publishLater is a publish with a due moment. No timer lives in the
// service -- the consumer's poll promotes what is due -- so the tests pin both
// halves: the driver's due set, and a service where the body is not called
// before the delay and is called after it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_SOURCE } from '../src/emit/queue.ts';
import { startService } from './harness.ts';

function loadMemory(now: { at: number }) {
  const process = { env: {} };
  const FakeDate = { now: () => now.at };
  const factory = new Function('process', 'setTimeout', 'clearTimeout', 'Date',
    QUEUE_SOURCE + '\nreturn { queueDriver };');
  return factory(process, setTimeout, clearTimeout, FakeDate) as {
    queueDriver: {
      later(topic: string, text: string, delayMs: number): Promise<boolean>;
      receive(topic: string): Promise<string | null>;
      publish(topic: string, text: string): Promise<boolean>;
    };
  };
}

function loadRedis(replies: string[]) {
  const sent: string[] = [];
  const net = {
    createConnection(_options: unknown, connected: () => void) {
      const handlers: Record<string, (chunk?: Buffer) => void> = {};
      const socket = {
        destroyed: false,
        on(event: string, handler: (chunk?: Buffer) => void) { handlers[event] = handler; },
        write(text: string) {
          sent.push(text);
          const reply = replies.shift();
          setTimeout(() => { if (reply != null) handlers.data?.(Buffer.from(reply)); }, 0);
        },
        destroy() { socket.destroyed = true; },
      };
      setTimeout(() => connected(), 0);
      return socket;
    },
  };
  const process = { env: { QUEUE_REDIS_URL: 'redis://kv:6379' } };
  const factory = new Function('process', 'net', 'Buffer', 'setTimeout', 'clearTimeout',
    QUEUE_SOURCE + '\nreturn { queueDriver };');
  return {
    ...(factory(process, net, Buffer, setTimeout, clearTimeout) as {
      queueDriver: {
        later(topic: string, text: string, delayMs: number): Promise<boolean>;
        receive(topic: string): Promise<string | null>;
      };
    }),
    sent,
  };
}

test('memory: a delayed message is invisible until its due moment', async () => {
  const clock = { at: 1_000_000 };
  const { queueDriver } = loadMemory(clock);
  await queueDriver.later('jobs', '{"payload":1}', 5000);
  assert.equal(await queueDriver.receive('jobs'), null, 'not due yet');
  clock.at += 4999;
  assert.equal(await queueDriver.receive('jobs'), null, 'one millisecond early');
  clock.at += 1;
  assert.equal(await queueDriver.receive('jobs'), '{"payload":1}', 'due, and it arrives');
  assert.equal(await queueDriver.receive('jobs'), null, 'exactly once');
});

test('memory: two identical payloads with different due moments both arrive', async () => {
  const clock = { at: 1_000_000 };
  const { queueDriver } = loadMemory(clock);
  await queueDriver.later('jobs', '{"payload":1}', 2000);
  await queueDriver.later('jobs', '{"payload":1}', 1000);
  clock.at += 1000;
  assert.equal(await queueDriver.receive('jobs'), '{"payload":1}');
  assert.equal(await queueDriver.receive('jobs'), null, 'the later copy waits');
  clock.at += 1000;
  assert.equal(await queueDriver.receive('jobs'), '{"payload":1}');
});

test('memory: a later message queues behind an earlier plain publish', async () => {
  const clock = { at: 1_000_000 };
  const { queueDriver } = loadMemory(clock);
  await queueDriver.later('jobs', 'later', 0);
  await queueDriver.publish('jobs', 'now');
  assert.equal(await queueDriver.receive('jobs'), 'now', 'publish keeps its place');
  assert.equal(await queueDriver.receive('jobs'), 'later');
});

test('redis: a delayed message is a ZADD with its due score', async () => {
  const queue = loadRedis([':1\r\n']);
  await queue.queueDriver.later('jobs', '{"payload":1}', 30000);
  assert.match(queue.sent[0], /ZADD/);
  assert.match(queue.sent[0], /arcod:q:jobs:later/);
  const score = Number(/\$\d+\r\n(\d+)\r\n/.exec(queue.sent[0])?.[1]);
  assert.ok(score > Date.now() + 25000, 'the score is the due moment');
  assert.match(queue.sent[0], /payload/, 'the envelope travels whole, after a nonce');
});

test('redis: receive promotes the due member once, by claiming it with ZREM', async () => {
  const queue = loadRedis([
    '*1\r\n$16\r\nn1 {"payload":1}\r\n', // ZRANGEBYSCORE: one due member
    ':1\r\n',                            // ZREM: this replica claimed it
    '+OK\r\n',                           // RPUSH into the topic
    '$13\r\n{"payload":1}\r\n',
  ]);
  assert.equal(await queue.queueDriver.receive('jobs'), '{"payload":1}', 'the nonce is stripped');
  assert.match(queue.sent[0], /ZRANGEBYSCORE/);
  assert.match(queue.sent[1], /ZREM/);
  assert.match(queue.sent[2], /^\*3\r\n\$5\r\nRPUSH/, 'the member is pushed as the message');
  assert.match(queue.sent[2], /arcod:q:jobs\r\n/, 'into the topic list, not the set');
});

test('redis: a member another replica already claimed is not pushed again', async () => {
  const queue = loadRedis([
    '*1\r\n$6\r\nabc123\r\n', // ZRANGEBYSCORE sees it
    ':0\r\n',                 // ZREM: the other replica won
    '$-1\r\n',                // LPOP: nothing to hand over
  ]);
  assert.equal(await queue.queueDriver.receive('jobs'), null);
  assert.equal(queue.sent.length, 3, 'no RPUSH for a member this replica did not claim');
});

const spec = [
  'module later @0.1.0 {}',
  '',
  'use capability arcod.std.queue @1',
  '',
  'error Invalid',
  '',
  'service Later : http {',
  '  uses events: queue',
  '',
  '  effects {',
  '    allow events.publishLater',
  '  }',
  '',
  '  contract {',
  '    public op schedule(id: string, delaySeconds: int) -> bool {',
  '      route: "POST /v1/schedule"',
  '      effects: events.publishLater',
  '      errors: Invalid',
  '    }',
  '',
  '    public op seen() -> { ids: list<string> } {',
  '      route: "GET /v1/seen"',
  '      errors: Invalid',
  '    }',
  '',
  '    job work(id: string) {',
  '      on: events.jobs',
  '      retry: 0',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  schedule: 'export async function schedule(input, io) { return { result: await io.queuePublishLater("jobs", { id: String(input.id) }, Number(input.delaySeconds)) }; }',
  seen: 'export async function seen(input, io) { return { result: { ids: JSON.parse(await io.get("seen") || "[]") } }; }',
  work: [
    'export async function work(input, io) {',
    '  const ids = JSON.parse(await io.get("seen") || "[]");',
    '  ids.push(String(input.id));',
    '  await io.set("seen", JSON.stringify(ids));',
    '  return { result: true };',
    '}',
  ].join(String.fromCharCode(10)),
};

const sqlSpec = spec.replace('  uses events: queue', '  uses db: sql\n  uses events: queue');

test('sql: a delayed publish waits in the outbox row instead of the broker', async () => {
  const svc = await startService(sqlSpec, { impl });
  try {
    const res = await fetch(svc.base + '/v1/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b', delaySeconds: 1 }),
    });
    assert.equal(res.status, 201);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const early = await (await fetch(svc.base + '/v1/seen')).json();
    assert.deepEqual(early.ids, [], 'the relay holds a row that is not due yet');

    let seen: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const body = await (await fetch(svc.base + '/v1/seen')).json();
      seen = body.ids;
      if (seen.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(seen, ['b'], 'the due row reached the broker and the job ran');
  } finally {
    await svc.stop();
  }
});

test('a body publishes for later and the job runs only after the delay', async () => {
  const svc = await startService(spec, { impl });
  try {
    const started = Date.now();
    const res = await fetch(svc.base + '/v1/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', delaySeconds: 1 }),
    });
    assert.equal(res.status, 201);
    assert.equal(await res.json(), true, 'the broker accepted it');

    await new Promise((resolve) => setTimeout(resolve, 300));
    const early = await (await fetch(svc.base + '/v1/seen')).json();
    assert.deepEqual(early.ids, [], 'nothing runs before the due moment');

    let seen: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const body = await (await fetch(svc.base + '/v1/seen')).json();
      seen = body.ids;
      if (seen.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(seen, ['a'], 'the delayed job ran');
    assert.ok(Date.now() - started >= 900, 'and not before the delay');
  } finally {
    await svc.stop();
  }
});
