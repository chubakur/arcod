import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_SOURCE, consumerSource } from '../src/emit/queue.ts';

// The queue driver is emitted as source into the generated service; evaluating
// that source against a fake socket is the only place it runs in this repo.
function loadQueue(replies: string[]) {
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
  return { ...(factory(process, net, Buffer, setTimeout, clearTimeout) as { queueDriver: { dead(topic: string): Promise<string[]> } }), sent };
}

function consumerInputOf(params: string[]) {
  const src = consumerSource([{ topic: 'checkout', handler: 'mark', params, retry: 2 }]);
  const factory = new Function('queueDriver', 'makeIo', 'setTimeout', 'mark',
    src + '\nreturn { consumerInput };');
  const loaded = factory({}, () => ({}), setTimeout, () => ({})) as {
    consumerInput: (spec: { params: string[] }, payload: unknown) => Record<string, unknown>;
  };
  return (payload: unknown) => loaded.consumerInput({ params }, payload);
}

test('dead() reads the LRANGE array instead of throwing on *', async () => {
  const queue = loadQueue([':2\r\n', '*2\r\n$1\r\na\r\n$1\r\nb\r\n']);
  assert.deepEqual(await queue.queueDriver.dead('deliveries'), ['a', 'b']);
  assert.match(queue.sent[1], /^\*4\r\n\$6\r\nLRANGE/);
});

test('an empty dead letter queue answers *0', async () => {
  const queue = loadQueue([':0\r\n']);
  assert.deepEqual(await queue.queueDriver.dead('deliveries'), []);
  assert.equal(queue.sent.length, 1, 'no LRANGE on an empty list');
});

test('a nested array is parsed recursively', async () => {
  const queue = loadQueue([':1\r\n', '*1\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n']);
  assert.deepEqual(await queue.queueDriver.dead('deliveries'), ['a,b']);
});

test('a single job parameter takes its field out of an object payload', () => {
  const input = consumerInputOf(['label']);
  assert.deepEqual(input({ label: 'one-time' }), { label: 'one-time' });
  assert.deepEqual(input({ label: 'x', extra: true }), { label: 'x' });
});

test('a scalar and an object without the key stay whole', () => {
  const input = consumerInputOf(['label']);
  assert.deepEqual(input('one-time'), { label: 'one-time' });
  assert.deepEqual(input(42), { label: 42 });
  assert.deepEqual(input({ other: 1 }), { label: { other: 1 } });
  assert.deepEqual(input(null), { label: null });
});

test('two parameters still spread the payload by name', () => {
  const input = consumerInputOf(['label', 'count']);
  assert.deepEqual(input({ label: 'x', count: 2 }), { label: 'x', count: 2 });
  assert.deepEqual(input({ label: 'x' }), { label: 'x', count: null });
});
