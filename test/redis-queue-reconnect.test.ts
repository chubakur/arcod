import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_SOURCE } from '../src/emit/queue.ts';

// A broker restart is the normal case for a long-lived consumer: the socket
// closes, and every command that was in flight has to fail instead of waiting
// for a reply that will never come. The driver then has to open a fresh
// connection with an empty buffer.

interface FakeSocket {
  destroyed: boolean;
  handlers: Record<string, (chunk?: Buffer) => void>;
  writes: string[];
  on(event: string, handler: (chunk?: Buffer) => void): void;
  write(text: string): void;
  destroy(): void;
}

function loadQueue(options: { env?: Record<string, string>; connect?: (index: number) => boolean } = {}) {
  const shouldConnect = options.connect ?? (() => true);
  const sockets: FakeSocket[] = [];
  const net = {
    createConnection(_options: unknown, connected: () => void) {
      const socket: FakeSocket = {
        destroyed: false,
        handlers: {},
        writes: [],
        on(event, handler) {
          socket.handlers[event] = handler;
        },
        write(text) {
          socket.writes.push(text);
        },
        destroy() {
          if (socket.destroyed) return;
          socket.destroyed = true;
          socket.handlers.close?.();
        },
      };
      sockets.push(socket);
      setTimeout(() => {
        if (!socket.destroyed && shouldConnect(sockets.length - 1)) connected();
      }, 0);
      return socket;
    },
  };
  const process = { env: { QUEUE_REDIS_URL: 'redis://kv:6379', ...(options.env ?? {}) } };
  const factory = new Function('process', 'net', 'Buffer', 'setTimeout', 'clearTimeout',
    QUEUE_SOURCE + '\nreturn { queueDriver };');
  const driver = (factory(process, net, Buffer, setTimeout, clearTimeout) as {
    queueDriver: { publish(topic: string, text: string): Promise<boolean>; receive(topic: string): Promise<string | null> };
  }).queueDriver;
  return { driver, sockets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('an in-flight command fails when the broker closes the socket', async () => {
  const { driver, sockets } = loadQueue();
  const publish = driver.publish('deliveries', 'one');
  await tick();
  assert.equal(sockets.length, 1, 'one connection');
  assert.match(sockets[0].writes[0], /RPUSH/);
  sockets[0].handlers.close?.();
  await assert.rejects(publish, /connection closed/);
});

test('the next command reconnects after the socket closed', async () => {
  const { driver, sockets } = loadQueue();
  const first = driver.publish('deliveries', 'one');
  await tick();
  sockets[0].handlers.close?.();
  await assert.rejects(first, /connection closed/);

  const second = driver.publish('deliveries', 'two');
  await tick();
  assert.equal(sockets.length, 2, 'a new connection is opened');
  sockets[1].handlers.data?.(Buffer.from('+OK\r\n'));
  assert.equal(await second, true);
});

test('a half-written reply from the old connection does not leak into the new one', async () => {
  const { driver, sockets } = loadQueue();
  const first = driver.receive('deliveries');
  await tick();
  sockets[0].handlers.data?.(Buffer.from('$3\r\nms'));
  sockets[0].handlers.close?.();
  await assert.rejects(first, /connection closed/);

  const second = driver.receive('deliveries');
  await tick();
  // receive promotes the delay set first, then the topic list.
  sockets[1].handlers.data?.(Buffer.from('*0\r\n'));
  await tick();
  sockets[1].handlers.data?.(Buffer.from('$3\r\nmsg\r\n'));
  assert.equal(await second, 'msg');
});

test('a corrupt reply rejects the caller and drops the socket', async () => {
  const { driver, sockets } = loadQueue();
  const first = driver.publish('deliveries', 'one');
  await tick();
  assert.doesNotThrow(() => sockets[0].handlers.data?.(Buffer.from('?\r\n')), 'no throw from the data event');
  await assert.rejects(first, /unexpected RESP type/);
  assert.equal(sockets[0].destroyed, true, 'the unusable socket is closed');
});

test('a silent broker fails the receive instead of blocking the consumer', async () => {
  const { driver, sockets } = loadQueue({ env: { ARCod_QUEUE_TIMEOUT_MS: '30' } });
  const receive = driver.receive('deliveries');
  await tick();
  assert.match(sockets[0].writes[0], /ZRANGEBYSCORE/, 'promotion is a command like any other');
  await assert.rejects(receive, /redis command timeout/);
  assert.equal(sockets[0].destroyed, true, 'the stalled stream is dropped');

  const next = driver.receive('deliveries');
  await tick();
  assert.equal(sockets.length, 2, 'the retry opens a fresh connection');
  sockets[1].handlers.data?.(Buffer.from('*0\r\n'));
  await tick();
  sockets[1].handlers.data?.(Buffer.from('$3\r\nmsg\r\n'));
  assert.equal(await next, 'msg');
});

test('a broker that never accepts fails the connect instead of blocking the consumer', async () => {
  const { driver, sockets } = loadQueue({ env: { ARCod_QUEUE_TIMEOUT_MS: '30' }, connect: (index) => index > 0 });
  await assert.rejects(driver.receive('deliveries'), /redis connect timeout/);
  assert.equal(sockets[0].destroyed, true);

  const next = driver.receive('deliveries');
  await tick();
  assert.equal(sockets.length, 2);
  sockets[1].handlers.data?.(Buffer.from('*0\r\n'));
  await tick();
  sockets[1].handlers.data?.(Buffer.from('$-1\r\n'));
  assert.equal(await next, null);
});
