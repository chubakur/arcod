import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { emitService } from '../src/emit/service.ts';

// The kv service talks to redis through an emitted class, not an import. Load
// that class from the emitted text and drive it with fake sockets: a broker
// restart must fail the request in flight and the next request must work on a
// fresh connection with an empty buffer.

interface FakeSocket {
  destroyed: boolean;
  handlers: Record<string, (chunk?: Buffer) => void>;
  writes: string[];
  on(event: string, handler: (chunk?: Buffer) => void): void;
  write(text: string): void;
  destroy(): void;
}

const spec = await readFile(new URL('../examples/onetimemessage/main.arc', import.meta.url), 'utf8');

function loadStore(options: { connect?: (index: number) => boolean } = {}) {
  const shouldConnect = options.connect ?? (() => true);
  const source = emitService(parse(spec, 'main.arc'));
  const start = source.indexOf('function parseReply(');
  const end = source.indexOf('class MemoryStore');
  assert.ok(start > 0 && end > start, 'redis client is part of a kv service');
  const chunk = source.slice(start, end);

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
  const factory = new Function('net', 'Buffer', 'setTimeout', 'clearTimeout',
    chunk + '\nreturn { RedisStore };');
  const RedisStore = (factory(net, Buffer, setTimeout, clearTimeout) as {
    RedisStore: new (host: string, port: number, timeoutMs?: number) => { get(key: string): Promise<string | null> };
  }).RedisStore;
  return { RedisStore, sockets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('a get in flight rejects when redis drops the connection', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379);
  const pending = store.get('one');
  await tick();
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].writes[0], /GET/);
  sockets[0].handlers.close?.();
  await assert.rejects(pending, /connection closed/);
});

test('the next get reconnects and answers on the new socket', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379);
  const first = store.get('one');
  await tick();
  sockets[0].handlers.close?.();
  await assert.rejects(first, /connection closed/);

  const second = store.get('two');
  await tick();
  assert.equal(sockets.length, 2, 'a new connection is opened');
  sockets[1].handlers.data?.(Buffer.from('$3\r\n2nd\r\n'));
  assert.equal(await second, '2nd');
});

test('a partial reply from the old socket does not corrupt the new one', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379);
  const first = store.get('one');
  await tick();
  sockets[0].handlers.data?.(Buffer.from('$3\r\non'));
  sockets[0].handlers.close?.();
  await assert.rejects(first, /connection closed/);

  const second = store.get('two');
  await tick();
  sockets[1].handlers.data?.(Buffer.from('$3\r\ntwo\r\n'));
  assert.equal(await second, 'two');
});

test('a corrupt reply rejects and drops the unusable socket', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379);
  const first = store.get('one');
  await tick();
  assert.doesNotThrow(() => sockets[0].handlers.data?.(Buffer.from('?\r\n')));
  await assert.rejects(first, /unexpected RESP type/);
  assert.equal(sockets[0].destroyed, true);
});

test('the emitted client has one definition of get', () => {
  const source = emitService(parse(spec, 'main.arc'));
  const start = source.indexOf('class RedisStore');
  const end = source.indexOf('class MemoryStore');
  const body = source.slice(start, end);
  assert.equal(body.match(/async get\(/g)?.length, 1, 'duplicate get removed');
});

test('a broker that accepts but never answers fails the command instead of hanging', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379, 30);
  const pending = store.get('one');
  await assert.rejects(pending, /redis command timeout/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyed, true, 'the stream is dropped with the timed-out call');
});

test('a broker that never accepts fails the connect and the next call retries', async () => {
  const { RedisStore, sockets } = loadStore({ connect: (index) => index > 0 });
  const store = new RedisStore('kv', 6379, 30);
  await assert.rejects(store.get('one'), /redis connect timeout/);
  assert.equal(sockets[0].destroyed, true);

  const second = store.get('two');
  await tick();
  assert.equal(sockets.length, 2, 'the timed-out attempt does not stick');
  sockets[1].handlers.data?.(Buffer.from('$3\r\n2nd\r\n'));
  assert.equal(await second, '2nd');
});

test('a stale socket closing after a reconnect does not fail the new call', async () => {
  const { RedisStore, sockets } = loadStore();
  const store = new RedisStore('kv', 6379);
  const first = store.get('one');
  await tick();
  sockets[0].handlers.close?.();
  await assert.rejects(first, /connection closed/);

  const second = store.get('two');
  await tick();
  assert.equal(sockets.length, 2);
  sockets[0].handlers.close?.();
  sockets[1].handlers.data?.(Buffer.from('$3\r\n2nd\r\n'));
  assert.equal(await second, '2nd');
});
