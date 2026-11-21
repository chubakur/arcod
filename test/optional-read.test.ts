// An optional field may have no value, and a store that never received one said
// so in two spellings: kv kept the key out of the record (JSON drops undefined),
// while a nullable column read back as null, so the same fetch answered two
// shapes per driver. Every read (fetch and find) now names every declared
// column, with null where it has no value; the insert response still shows the
// record the body handed over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

function spec(store: 'kv' | 'sql'): string {
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module optionalread @0.1.0 {}',
    '',
    'use capability arcod.std.' + store + ' @1',
    'use capability arcod.std.ids @1',
    '',
    'type Note = { id: uuid, title: string, body: string?, tags: list<string>? }',
    '',
    'error Invalid',
    'error NotFound',
    '',
    'service OptionalRead : http {',
    '  uses store: ' + store,
    '  uses uuid: ids',
    '',
    '  effects {',
    '    allow store.insert, store.fetch, store.find, uuid.new',
    '  }',
    '',
    '  contract {',
    '    public op put(title: string) -> Note {',
    '      route: "POST /v1/notes"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '',
    '    public op nul(title: string) -> Note {',
    '      route: "POST /v1/nulls"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '',
    '    public op tagged(title: string) -> Note {',
    '      route: "POST /v1/tagged"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '',
    '    public op get(id: uuid) -> Note {',
    '      route: "GET /v1/notes/:id"',
    '      effects: store.fetch',
    '      errors: Invalid, NotFound',
    '    }',
    '',
    '    public op all() -> { items: list<Note> } {',
    '      route: "GET /v1/notes"',
    '      effects: store.find',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind store -> ' + bind,
    '  bind uuid -> local',
    '}',
    '',
  ].join(String.fromCharCode(10));
}

const impl: Record<string, string> = {
  put: [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Note', { id: io.new(), title: input.title }) };",
    '}',
  ].join(String.fromCharCode(10)),
  nul: [
    'export async function nul(input, io) {',
    "  return { result: await io.insert('Note', { id: io.new(), title: input.title, body: null, tags: null }) };",
    '}',
  ].join(String.fromCharCode(10)),
  tagged: [
    'export async function tagged(input, io) {',
    "  return { result: await io.insert('Note', { id: io.new(), title: input.title, tags: ['a', 'b'] }) };",
    '}',
  ].join(String.fromCharCode(10)),
  get: [
    'export async function get(input, io) {',
    "  return { result: await io.fetch('Note', input.id) };",
    '}',
  ].join(String.fromCharCode(10)),
  all: [
    'export async function all(input, io) {',
    "  const page = await io.find('Note', {});",
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function created(base: string, path: string, title: string) {
  const res = await post(base, path, { title });
  assert.equal(res.status, 201, 'insert succeeds: ' + path);
  return await res.json();
}

const stores: Array<'kv' | 'sql'> = ['kv', 'sql'];

for (const store of stores) {
  test(store + ': an optional field reads back as null, absent on the insert response', async () => {
    const svc = await startService(spec(store), { impl });
    try {
      const plain = await created(svc.base, '/v1/notes', 'plain');
      assert.equal(Object.prototype.hasOwnProperty.call(plain, 'body'), false, 'the insert response is the record the body built');
      const got = await fetch(svc.base + '/v1/notes/' + plain.id);
      assert.equal(got.status, 200);
      const read = await got.json();
      assert.equal(Object.prototype.hasOwnProperty.call(read, 'body'), true, 'a read names the declared optional field');
      assert.equal(read.body, null);
      assert.equal(read.tags, null);

      const nul = await created(svc.base, '/v1/nulls', 'nul');
      const nulRead = await (await fetch(svc.base + '/v1/notes/' + nul.id)).json();
      assert.deepEqual(nulRead, { id: nul.id, title: 'nul', body: null, tags: null }, 'an explicit null and an absent value read the same');

      const tagged = await created(svc.base, '/v1/tagged', 'tagged');
      const taggedRead = await (await fetch(svc.base + '/v1/notes/' + tagged.id)).json();
      assert.deepEqual(taggedRead, { id: tagged.id, title: 'tagged', body: null, tags: ['a', 'b'] }, 'a value stays a value; the missing field is null');

      const page = await (await fetch(svc.base + '/v1/notes')).json();
      assert.equal(page.items.length, 3);
      for (const item of page.items) {
        assert.equal(Object.prototype.hasOwnProperty.call(item, 'body'), true, 'find names the declared optional field');
        assert.equal(item.body, null);
        assert.equal(Object.prototype.hasOwnProperty.call(item, 'tags'), true);
      }
      const foundTagged = page.items.find((item: { id: string }) => item.id === tagged.id);
      assert.deepEqual(foundTagged.tags, ['a', 'b']);
    } finally {
      await svc.stop();
    }
  });
}

const ARC = [
  'function ArcodError(name, fields) {',
  '  this.name = name;',
  '  this.error = name;',
  '  this.message = name;',
  '  if (fields && typeof fields === "object") {',
  '    for (const key of Object.keys(fields)) this[key] = fields[key];',
  '  }',
  '}',
  'ArcodError.prototype = Object.create(Error.prototype);',
  'ArcodError.prototype.constructor = ArcodError;',
].join(String.fromCharCode(10));

async function loadStore(source: string, name: string, extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-optional-read-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'title', base: 'string' },
  { name: 'body', base: 'string', nullable: true },
  { name: 'tags', base: 'list', nullable: true },
];

async function readsNull(store: any) {
  store.query = async () => ({ rows: [['n1', 'plain', null, null]], affected: 0 });
  const row = await store.entityFetch('note', columns, 'n1');
  assert.deepEqual(row, { id: 'n1', title: 'plain', body: null, tags: null }, 'a NULL column reaches the record as null');
}

test('mysql: a nullable column reads back as null', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  await readsNull(new SqlStore('mysql://localhost:3306/arcod'));
});

test('postgres: a nullable column reads back as null', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  await readsNull(new PgStore('postgres://localhost:5432/arcod'));
});
