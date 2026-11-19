import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STREAM_SOURCE } from '../src/emit/stream.ts';

// The websocket fan-out keeps a read-only redis connection in subscribe mode.
// When redis restarts that connection dies with every subscription on it, so
// the new socket has to announce the topics again — otherwise the service
// looks healthy and the websocket goes silent.

interface FakeSocket {
  destroyed: boolean;
  handlers: Record<string, (chunk?: Buffer) => void>;
  writes: string[];
  on(event: string, handler: (chunk?: Buffer) => void): void;
  write(text: string): void;
  destroy(): void;
}

const STREAM_CHANNEL = 'arcod:stream:';

function loadPubSub() {
  const start = STREAM_SOURCE.indexOf('function createStreamPubSub(');
  const end = STREAM_SOURCE.indexOf('const streamPub =');
  assert.ok(start > 0 && end > start, 'pub/sub factory is emitted');
  const chunk = STREAM_SOURCE.slice(start, end);

  const sockets: Array<FakeSocket & { connect: () => void }> = [];
  const net = {
    createConnection(_options: unknown, connected: () => void) {
      const socket: FakeSocket & { connect: () => void } = {
        destroyed: false,
        handlers: {},
        writes: [],
        connect: () => connected(),
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
      return socket;
    },
  };
  // The 500ms reconnect delay: run it when the test asks, not in real time.
  const timers: Array<() => void> = [];
  const setTimeout = (fn: () => void) => {
    timers.push(fn);
    return 0;
  };
  const delivered: Array<{ topic: string; payload: string }> = [];
  const wsDeliver = (topic: string, payload: string) => {
    delivered.push({ topic, payload });
  };

  const factory = new Function('net', 'Buffer', 'setTimeout', 'wsDeliver', 'STREAM_CHANNEL',
    chunk + '\nreturn { createStreamPubSub };');
  const create = (factory(net, Buffer, setTimeout, wsDeliver, STREAM_CHANNEL) as {
    createStreamPubSub(url: string): { subscribe(channel: string): Promise<void>; unsubscribe(channel: string): Promise<void> };
  }).createStreamPubSub;
  return { create, sockets, timers, delivered };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('a new socket announces every topic that still has listeners', async () => {
  const { create, sockets, timers } = loadPubSub();
  const bus = create('redis://bus:6379');
  const subscribed = bus.subscribe(STREAM_CHANNEL + 'room');
  await tick();
  assert.equal(sockets.length, 1);
  sockets[0].connect();
  await subscribed;
  assert.equal(sockets[0].writes.length, 1);
  assert.match(sockets[0].writes[0], /SUBSCRIBE/);

  sockets[0].handlers.close?.();
  assert.equal(timers.length, 1, 'a reconnect is scheduled');
  timers[0]();
  await tick();
  assert.equal(sockets.length, 2, 'a new socket is opened');
  sockets[1].connect();
  await tick();
  assert.equal(sockets[1].writes.length, 1, 'the topic is announced again');
  assert.match(sockets[1].writes[0], /SUBSCRIBE/);
  assert.match(sockets[1].writes[0], /arcod:stream:room/);
});

test('a channel nobody listens to is not announced again', async () => {
  const { create, sockets, timers } = loadPubSub();
  const bus = create('redis://bus:6379');
  const subscribed = bus.subscribe(STREAM_CHANNEL + 'room');
  await tick();
  sockets[0].connect();
  await subscribed;
  await bus.unsubscribe(STREAM_CHANNEL + 'room');
  assert.match(sockets[0].writes.at(-1)!, /UNSUBSCRIBE/);

  sockets[0].handlers.close?.();
  assert.equal(timers.length, 0, 'nothing left to resubscribe, so no reconnect');
});

test('a half-written push from the old socket does not corrupt the new one', async () => {
  const { create, sockets, timers, delivered } = loadPubSub();
  const bus = create('redis://bus:6379');
  const subscribed = bus.subscribe(STREAM_CHANNEL + 'room');
  await tick();
  sockets[0].connect();
  await subscribed;

  sockets[0].handlers.data?.(Buffer.from('*3\r\n$7\r\nmessage\r\n$17\r\narcod:stream:roo'));
  sockets[0].handlers.close?.();
  timers[0]();
  await tick();
  sockets[1].connect();
  await tick();
  const push = '*3\r\n$7\r\nmessage\r\n$17\r\narcod:stream:room\r\n$2\r\nhi\r\n';
  sockets[1].handlers.data?.(Buffer.from(push));
  assert.deepEqual(delivered, [{ topic: 'room', payload: 'hi' }]);
});

test('a second subscribe on a live socket is not sent twice', async () => {
  const { create, sockets } = loadPubSub();
  const bus = create('redis://bus:6379');
  const first = bus.subscribe(STREAM_CHANNEL + 'room');
  await tick();
  sockets[0].connect();
  await first;
  const second = bus.subscribe(STREAM_CHANNEL + 'room2');
  await second;
  assert.equal(sockets[0].writes.length, 2, 'one SUBSCRIBE per channel');
});
