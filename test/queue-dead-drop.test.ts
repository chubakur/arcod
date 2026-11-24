// A dead letter was read-only: after a replay the record stayed in the list, so
// /v1/dead grew forever and "not yet handled" looked like "handled and somehow
// still there". drop(topic, payload) removes the first entry carrying that
// payload -- the body names the payload, both drivers remove the stored line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_SOURCE } from '../src/emit/queue.ts';
import { startService } from './harness.ts';

function loadMemory() {
  const process = { env: {} };
  const factory = new Function('process', 'setTimeout', 'clearTimeout',
    QUEUE_SOURCE + '\nreturn { queueDriver };');
  return factory(process, setTimeout, clearTimeout) as {
    queueDriver: {
      toDead(topic: string, text: string): Promise<boolean>;
      dead(topic: string): Promise<string[]>;
      removeDead(topic: string, text: string): Promise<boolean>;
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
      queueDriver: { removeDead(topic: string, text: string): Promise<boolean> };
    }),
    sent,
  };
}

test('memory: removeDead takes exactly the entry it was given', async () => {
  const { queueDriver } = loadMemory();
  assert.equal(await queueDriver.removeDead('jobs', 'a'), false, 'nothing to remove');
  await queueDriver.toDead('jobs', 'a');
  await queueDriver.toDead('jobs', 'b');
  assert.deepEqual(await queueDriver.dead('jobs'), ['a', 'b']);

  assert.equal(await queueDriver.removeDead('jobs', 'a'), true);
  assert.deepEqual(await queueDriver.dead('jobs'), ['b'], 'only the named entry went');
  assert.equal(await queueDriver.removeDead('jobs', 'a'), false, 'a second drop is false');
});

test('redis: removeDead is one LREM of the stored line', async () => {
  const queue = loadRedis([':1\r\n']);
  assert.equal(await queue.queueDriver.removeDead('jobs', '{"payload":1}'), true);
  assert.match(queue.sent[0], /LREM/, 'the driver speaks LREM');
  assert.match(queue.sent[0], /arcod:q:jobs:dead/);

  const missing = loadRedis([':0\r\n']);
  assert.equal(await missing.queueDriver.removeDead('jobs', '{"payload":1}'), false);
});

const spec = [
  'module dlq @0.1.0 {}',
  '',
  'use capability arcod.std.queue @1',
  '',
  'error Invalid',
  '',
  'service Dlq : http {',
  '  uses events: queue',
  '',
  '  effects {',
  '    allow events.publish, events.drop',
  '  }',
  '',
  '  contract {',
  '    public op dropMissing() -> { dropped: bool } {',
  '      route: "POST /v1/drop"',
  '      effects: events.drop',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  dropMissing: [
    'export async function dropMissing(input, io) {',
    '  const dropped = await io.queueDeadDrop("jobs", { id: "absent" });',
    '  return { result: { dropped } };',
    '}',
  ].join(String.fromCharCode(10)),
};

test('the body reaches io.queueDeadDrop and an absent payload answers false', async () => {
  const svc = await startService(spec, { impl });
  try {
    const res = await fetch(svc.base + '/v1/drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { dropped: false });
  } finally {
    await svc.stop();
  }
});

const liveSpec = [
  'module dlq2 @0.1.0 {}',
  '',
  'use capability arcod.std.queue @1',
  '',
  'error Invalid',
  '',
  'service Dlq2 : http {',
  '  uses events: queue',
  '',
  '  effects {',
  '    allow events.publish, events.dead, events.drop',
  '  }',
  '',
  '  contract {',
  '    public op publishIt(id: string) -> bool {',
  '      route: "POST /v1/publish"',
  '      effects: events.publish',
  '      errors: Invalid',
  '    }',
  '',
  '    public op deadCount() -> { items: list<any> } {',
  '      route: "GET /v1/dead"',
  '      effects: events.dead',
  '      errors: Invalid',
  '    }',
  '',
  '    public op dropIt(id: string) -> { dropped: bool } {',
  '      route: "POST /v1/drop-it"',
  '      effects: events.drop',
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

const liveImpl = {
  publishIt: 'export async function publishIt(input, io) { return { result: await io.queuePublish("jobs", { id: String(input.id) }) }; }',
  deadCount: 'export async function deadCount(input, io) { return { result: { items: await io.queueDead("jobs") } }; }',
  dropIt: 'export async function dropIt(input, io) { return { result: { dropped: await io.queueDeadDrop("jobs", { id: String(input.id) }) } }; }',
  work: 'export async function work(input, io) { throw new Error("sink is down"); }',
};

test('a replayed message leaves the dead letter, and a second drop answers false', async () => {
  const svc = await startService(liveSpec, { impl: liveImpl });
  try {
    const sent = await fetch(svc.base + '/v1/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a' }) });
    assert.equal(sent.status, 201);

    let dead: any = null;
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(svc.base + '/v1/dead');
      dead = await res.json();
      if (Array.isArray(dead.items) && dead.items.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(dead.items.length, 1, 'the failing job lands in the dead letter');
    assert.deepEqual(dead.items[0].payload, { id: 'a' });

    const dropped = await fetch(svc.base + '/v1/drop-it', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a' }) });
    assert.deepEqual(await dropped.json(), { dropped: true });

    const after = await (await fetch(svc.base + '/v1/dead')).json();
    assert.deepEqual(after.items, [], 'the handled message is gone');

    const again = await fetch(svc.base + '/v1/drop-it', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a' }) });
    assert.deepEqual(await again.json(), { dropped: false });
  } finally {
    await svc.stop();
  }
});
