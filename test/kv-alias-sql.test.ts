// B117: a sql-storing service can keep a kv alias on redis. Entities stay in
// the sql tables; the message/TTL pair ('msg:', 'gone:') goes to the alias's
// redis. Before this, A094 refused the bind, so the only choices were a TTL
// table inside sql (no cheap expiry) or a memory driver that lost the shared
// store. These tests pin the check, the emitted split and a live round trip
// against a fake redis.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { composeYaml } from '../src/emit/compose.ts';
import { emitService } from '../src/emit/service.ts';
import { parse } from '../src/parser.ts';
import { startService } from './harness.ts';

const spec = [
  'module cache @0.1.0 {}',
  '',
  'use capability arcod.std.sql @1',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type NoteId = uuid',
  'type Note = { id: NoteId, text: string }',
  '',
  'service Notes : http {',
  '  uses store: sql(ttl: 31536000s)',
  '  uses cache: kv(ttl: 900s)',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.fetch, cache.get, cache.set, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(text: string) -> NoteId {',
  '      route: "POST /v1/notes"',
  '      effects: store.insert, cache.set, uuid.new',
  '      post: result != null',
  '    }',
  '',
  '    public op read(id: NoteId) -> string {',
  '      route: "GET /v1/notes/:id"',
  '      effects: store.fetch, cache.get',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> mysql',
  '  bind cache -> redis',
  '  bind uuid -> local',
  '  deploy docker',
  '}',
  '',
].join('\n');

const impl = {
  put: [
    'export async function put(input, io) {',
    '  const id = io.new();',
    '  await io.insert("Note", { id, text: input.text });',
    '  await io.set("cache:" + id, input.text);',
    '  return { result: id };',
    '}',
  ].join('\n'),
  read: [
    'export async function read(input, io) {',
    '  const note = await io.fetch("Note", input.id);',
    '  const cached = await io.get("cache:" + input.id);',
    '  if (!note || cached !== note.text) return { result: "" };',
    '  return { result: cached };',
    '}',
  ].join('\n'),
};

test('a redis bind next to a sql store is legal and splits the emitted store', () => {
  const mod = parse(spec, 'main.arc');
  const diags = check(mod);
  assert.deepEqual(
    diags.filter((item) => item.severity === 'error'),
    [],
    diags.map((item) => item.code + ':' + item.message).join(' | '),
  );
  assert.deepEqual(diags.filter((item) => item.code === 'A094'), [], 'A094 is retired');

  const source = emitService(mod, { impl });
  assert.ok(source.includes('class RedisStore'), 'the redis client travels with the sql build');
  assert.ok(source.includes('const entityStore = spannedStore('), 'entities keep the sql store');
  assert.ok(source.includes('const kvStore = spannedStore('), 'the kv alias gets its own store');
  assert.match(source, /kvStore = spannedStore\(process\.env\.KV_DRIVER === 'memory'/);
  assert.ok(source.includes('const store = kvOver(entityStore, kvStore);'), 'one facade, two stores');
  assert.match(source, /"ttlMs": 900000/, 'the cache honours its own ttl, not the sql store\'s');

  const compose = composeYaml(mod, 8080);
  assert.match(compose, /KV_HOST: "redis"/);
  assert.ok(compose.includes('image: redis:7-alpine'), 'the alias actually starts a redis');
});

test('without a kv alias a sql service still carries no redis client', () => {
  const plain = parse(
    spec
      .replace('  uses cache: kv(ttl: 900s)\n', '')
      .replace('allow store.insert, store.fetch, cache.get, cache.set, uuid.new', 'allow store.insert, store.fetch, uuid.new')
      .replace('effects: store.insert, cache.set, uuid.new', 'effects: store.insert, uuid.new')
      .replace('effects: store.fetch, cache.get', 'effects: store.fetch'),
    'main.arc',
  );
  const source = emitService(plain, { impl });
  assert.ok(!source.includes('class RedisStore'), 'no second store is promised');
  assert.ok(!source.includes('kvOver('), 'no split without a kv alias');
});

// The smallest redis a store needs here: SET with PX, GET, EXISTS, DEL, PING.
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

function fakeRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, string>();
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
        else if (verb === 'SET') {
          const key = args[0] ?? '';
          data.set(key, args[1] ?? '');
          const px = args.findIndex((arg) => String(arg).toUpperCase() === 'PX');
          if (px >= 0) ttls.set(key, args[px + 1] ?? '');
          socket.write('+OK\r\n');
        } else if (verb === 'DEL') socket.write(':' + (data.delete(args[0] ?? '') ? 1 : 0) + '\r\n');
        else if (verb === 'EXISTS') socket.write(':' + (data.has(args[0] ?? '') ? 1 : 0) + '\r\n');
        else socket.write('+OK\r\n');
      }
    });
  });
  return { server, data, ttls };
}

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });

test('a live sql service writes the cache to redis, not to the sql kv table', async () => {
  const redis = fakeRedis();
  const port = await listen(redis.server);
  const svc = await startService(spec, {
    impl,
    env: { KV_DRIVER: 'redis', KV_HOST: '127.0.0.1', KV_PORT: String(port) },
  });
  try {
    const created = await fetch(svc.base + '/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const createdBody = JSON.parse(createdText) as string | { id?: string };
    const id = typeof createdBody === 'string' ? createdBody : String(createdBody.id ?? '');
    assert.match(id, /^[0-9a-f-]{36}$/, createdText);

    const key = 'msg:cache:' + id;
    assert.equal(redis.data.has(key), true, 'the cache write reached redis');
    assert.deepEqual(JSON.parse(redis.data.get(key)!), { b: 'hello', h: null });
    assert.equal(redis.ttls.get(key), '900000', 'the alias ttl, not the sql ttl');

    const read = await fetch(svc.base + '/v1/notes/' + id);
    assert.equal(read.status, 200);
    assert.equal(await read.text(), 'hello', 'the entity came from sql and the value from redis');
  } finally {
    await svc.stop();
    redis.server.close();
  }
});
