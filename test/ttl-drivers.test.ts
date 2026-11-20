import { test } from 'node:test';
import assert from 'node:assert/strict';

// `ttl` is the one `uses` parameter an adapter executes, and it behaves
// differently per driver: on kv it is the lifetime of every record, entity rows
// included, with a silent 999 s default; on sql it bounds the adapter's own
// rows ('msg:', 'outbox:') and never entity tables. That difference was only
// in the emitter, so the READMEs said 'it sets the record expiry' for both
// drivers and a kv domain store quietly lost rows after 16 minutes. These
// tests pin the contract the docs now state.

const spec = (store: string, ttl: string | null) => [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.' + (store === 'sql' ? 'sql' : 'kv') + ' @1',
  'use capability arcod.std.ids @1',
  '',
  'type EntryId = uuid',
  'type Entry = { id: EntryId, amount: int }',
  '',
  'error Invalid',
  '',
  'service Ledger : http {',
  '  uses store: ' + store + (ttl ? '(ttl: ' + ttl + ')' : ''),
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.fetch, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op add(amount: int) -> { ok: bool } {',
  '      route: "POST /v1/add"',
  '      effects: store.insert',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  add: [
    'export async function add(input, io) {',
    '  await io.insert("Entry", { id: io.new(), amount: Number(input.amount) });',
    '  return { result: { ok: true } };',
    '}',
  ].join('\\n'),
};

async function emit(store: string, ttl: string | null): Promise<string> {
  const { emitService } = await import('../src/emit/service.ts');
  const { parse } = await import('../src/parser.ts');
  return emitService(parse(spec(store, ttl), 'main.arc'), { impl });
}

function configValue(source: string, key: string): unknown {
  const start = source.indexOf('const CONFIG = ');
  assert.notEqual(start, -1, 'the bundle carries CONFIG');
  const end = source.indexOf('};', start);
  const body = source.slice(start + 'const CONFIG = '.length, end + 1);
  return (JSON.parse(body) as Record<string, unknown>)[key];
}

function ioInsertBody(source: string): string {
  const start = source.indexOf('    async insert(entity, record) {');
  assert.notEqual(start, -1, 'the io facade has an insert');
  const end = source.indexOf('    async ', start + 10);
  return source.slice(start, end < 0 ? start + 2000 : end);
}

test('kv without ttl keeps the 999 s default, and entity inserts use it', async () => {
  const source = await emit('kv', null);
  assert.equal(configValue(source, 'ttlMs'), 999000, 'the silent default is 999 s');
  assert.match(ioInsertBody(source), /CONFIG\.ttlMs/, 'a kv entity row is written with the storage TTL');
});

test('kv takes the ttl from the uses clause', async () => {
  const source = await emit('kv', '7d');
  assert.equal(configValue(source, 'ttlMs'), 7 * 24 * 60 * 60 * 1000);
});

test('sql never puts the ttl on an entity row', async () => {
  const source = await emit('sql', '7d');
  assert.equal(configValue(source, 'ttlMs'), 7 * 24 * 60 * 60 * 1000, 'the adapter rows still get the ttl');
  const body = ioInsertBody(source);
  assert.match(body, /store\.entityInsert\(meta\.table/, 'the entity goes to its table');
  assert.equal(body.includes('ttl'), false, 'an entity table has no expiry column');
});
