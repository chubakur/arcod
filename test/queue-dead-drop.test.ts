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
