// A record can predate a field. When a schema later declares `done: bool = false`,
// an old kv record simply has no such key; a read must answer the declared
// default, not null. fetch already ran withDefaults, find did not, so one record
// answered two shapes depending on how it was read. This suite seeds redis
// directly (a writer that never saw the new schema), then reads through the
// generated service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startService } from './harness.ts';

const spec = [
  'module finddefaults @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Note = { id: uuid, title: string, done: bool = false, score: int = 10, body: string? }',
  '',
  'error Invalid',
  'error NotFound',
  '',
  'service Notes : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.find, store.fetch, store.count, store.aggregate',
  '  }',
  '',
  '  contract {',
  '    public op all() -> { items: list<Note> } {',
  '      route: "GET /v1/notes"',
  '      effects: store.find',
  '    }',
  '',
  '    public op get(id: uuid) -> Note {',
  '      route: "GET /v1/notes/:id"',
  '      effects: store.fetch',
  '      errors: NotFound',
  '    }',
  '',
  '    public op open() -> { items: list<Note> } {',
  '      route: "GET /v1/open"',
  '      effects: store.find',
  '    }',
  '',
  '    public op total() -> int {',
  '      route: "GET /v1/total"',
  '      effects: store.aggregate',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '}',
  '',
].join(String.fromCharCode(10));

const impl: Record<string, string> = {
  all: [
    'export async function all(input, io) {',
    "  const page = await io.find('Note', {});",
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
  get: [
    'export async function get(input, io) {',
    "  return { result: await io.fetch('Note', input.id) };",
    '}',
  ].join(String.fromCharCode(10)),
  open: [
    'export async function open(input, io) {',
    "  const page = await io.find('Note', { where: { done: false } });",
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
  total: [
    'export async function total(input, io) {',
    "  return { result: await io.aggregate('Note', { field: 'score', op: 'sum' }) };",
    '}',
  ].join(String.fromCharCode(10)),
};

// The smallest redis the store uses for a find: KEYS, GET, PING. A command is
// a RESP array of bulk strings; replies are one line or a bulk string.
function parseCommand(text: string): { args: string[]; next: number } | null {
  if (!text.startsWith('*')) return null;
  const head = text.indexOf('\r\n');
  if (head < 0) return null;
  const count = Number(text.slice(1, head));
  let index = head + 2;
  const args: string[] = [];
  for (let i = 0; i < count; i++) {
    if (text[index] !== '$') return null;
    const line = text.indexOf('\r\n', index);
    if (line < 0) return null;
    const length = Number(text.slice(index + 1, line));
    const start = line + 2;
    const next = start + length + 2;
    if (text.length < next) return null;
    args.push(text.slice(start, start + length));
    index = next;
  }
  return { args, next: index };
}

function bulk(value: string | null): string {
  if (value == null) return '$-1\r\n';
  return '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n';
}

function fakeRedis(seed: Record<string, string>) {
  const data = new Map(Object.entries(seed));
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const command = parseCommand(buffer);
        if (!command) break;
        buffer = buffer.slice(command.next);
        const [name, ...args] = command.args;
        const verb = String(name || '').toUpperCase();
        if (verb === 'PING') socket.write('+PONG\r\n');
        else if (verb === 'GET') socket.write(bulk(data.get(args[0] ?? '') ?? null));
        else if (verb === 'KEYS') {
          const pattern = args[0] || '*';
          const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
          const keys = [...data.keys()].filter((key) => key.startsWith(prefix));
          socket.write('*' + keys.length + '\r\n' + keys.map((key) => bulk(key)).join(''));
        } else if (verb === 'SET') {
          data.set(args[0] ?? '', args[1] ?? '');
          socket.write('+OK\r\n');
        } else if (verb === 'DEL') socket.write(':' + (data.delete(args[0] ?? '') ? 1 : 0) + '\r\n');
        else if (verb === 'EXISTS') socket.write(':' + (data.has(args[0] ?? '') ? 1 : 0) + '\r\n');
        else socket.write('+OK\r\n');
      }
    });
  });
  return { server, data };
}

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });

const stored = (id: string, record: Record<string, unknown>) =>
  JSON.stringify({ b: Object.assign({ id }, record), h: null });

test('find fills a declared default for a record that predates the field', async () => {
  const redis = fakeRedis({
    'note:legacy': stored('legacy', { title: 'old' }),
    'note:taken': stored('taken', { title: 'new', done: true, score: 3, body: 'kept' }),
  });
  const port = await listen(redis.server);
  const svc = await startService(spec, {
    impl,
    env: { KV_DRIVER: 'redis', KV_HOST: '127.0.0.1', KV_PORT: String(port) },
  });
  try {
    const page = (await (await fetch(svc.base + '/v1/notes')).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const legacy = page.items.find((item) => item.id === 'legacy');
    assert.ok(legacy, 'the seeded record is listed');
    assert.equal(legacy.title, 'old');
    assert.equal(legacy.done, false, 'find answers the declared default, like fetch');
    assert.equal(legacy.body, null, 'and still names the optional field');
    assert.equal(redis.data.has('note:legacy'), true);
    assert.equal(
      JSON.parse(redis.data.get('note:legacy')!).b.done,
      undefined,
      'the read did not write the default back',
    );

    const taken = page.items.find((item) => item.id === 'taken');
    assert.ok(taken);
    assert.equal(taken.done, true, 'a stored value is never overwritten by the default');
    assert.equal(taken.body, 'kept');

    const one = (await (await fetch(svc.base + '/v1/notes/legacy')).json()) as Record<string, unknown>;
    assert.equal(one.done, false, 'fetch agrees with find');
    assert.equal(one.body, null);
    assert.equal(one.score, 10, 'fetch answers the numeric default too');

    // A filter and an aggregate run on the record a read presents, so a row
    // that predates the field must match `done = false` and carry score = 10;
    // filtering the raw record would hide it and drop it from the sum.
    const open = (await (await fetch(svc.base + '/v1/open')).json()) as {
      items: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      open.items.map((item) => item.id).sort(),
      ['legacy'],
      'where sees the declared default, not an absent key',
    );
    const total = await (await fetch(svc.base + '/v1/total')).json();
    assert.equal(total, 13, 'sum counts the defaulted score of the legacy row');
  } finally {
    await svc.stop();
    await new Promise((resolve) => redis.server.close(resolve));
  }
});
