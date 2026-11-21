// A cursor is a position in one order. A cursor from another order, or a
// corrupt one, used to be indistinguishable from "no cursor": the predicate
// was skipped, the query answered page one again, and a client following next
// looped forever without an error. The shape (an id and one value per sort
// field) is checked on every driver and a bad one is Invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

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
const PREAMBLE = [
  'function parseOrder(order) {',
  '  const list = Array.isArray(order) ? order : String(order || "id").split(",");',
  '  return list.map((entry) => {',
  '    const parts = String(entry).trim().split(/\\s+/);',
  '    return { field: parts[0], dir: (parts[1] || "asc").toLowerCase() === "desc" ? -1 : 1 };',
  '  });',
  '}',
  'function encodeCursor(values, id) {',
  '  return Buffer.from(JSON.stringify({ v: values, id })).toString("base64url");',
  '}',
  'function decodeCursor(cursor) {',
  '  try {',
  '    return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
].join(String.fromCharCode(10));

async function loadStore(source: string, name: string, extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-cursor-shape-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + PREAMBLE + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [{ name: 'id', base: 'string' }, { name: 'title', base: 'string' }];

async function checkSqlStore(store: any, label: string) {
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 0 };
  };

  const bad = [
    ['garbage', 'not a cursor'],
    ['few values', Buffer.from(JSON.stringify({ v: [], id: 'x' })).toString('base64url')],
    ['other order', Buffer.from(JSON.stringify({ v: ['x', 'y'], id: 'x' })).toString('base64url')],
  ] as const;

  for (const [name, cursor] of bad) {
    await assert.rejects(
      () => store.entityFind('item', columns, { order: 'title asc', cursor }),
      (error: any) => {
        assert.equal(error.name, 'Invalid', label + ': ' + name);
        assert.match(String(error.message), /cursor: not a page of this order \(expected 1 sort value\)/, label + ': ' + name);
        return true;
      },
    );
    assert.equal(statements.length, 0, label + ': a rejected cursor never reaches the driver (' + name + ')');
  }

  const good = Buffer.from(JSON.stringify({ v: ['b'], id: 'b' })).toString('base64url');
  await store.entityFind('item', columns, { order: 'title asc', cursor: good });
  assert.equal(statements.length, 1, label + ': a cursor of this order still pages');
  assert.match(statements[0], /title" > 'b'|`title` > UNHEX/, label + ': the clause names the field');
}

test('mysql: a cursor from another order is Invalid, never page one again', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  await checkSqlStore(new SqlStore('mysql://localhost:3306/arcod'), 'mysql');
});

test('postgres: a cursor from another order is Invalid, never page one again', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  await checkSqlStore(new PgStore('postgres://localhost:5432/arcod'), 'postgres');
});

const spec = [
  'module cursor @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type ItemId = uuid',
  'type Item = { id: ItemId, tag: string, seq: int }',
  '',
  'error Invalid',
  '',
  'service Cursor : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(seq: int) -> { id: ItemId } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op page(cursor: string?) -> { items: list<Item>, next: string? } {',
  '      route: "POST /v1/page"',
  '      effects: store.find',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  put: [
    'export async function put(input, io) {',
    '  const record = { id: io.new(), tag: "a", seq: Number(input.seq) };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  page: [
    'export async function page(input, io) {',
    '  const options = { order: "seq asc", limit: 1 };',
    '  if (input.cursor) options.cursor = String(input.cursor);',
    '  const found = await io.find("Item", options);',
    '  return { result: { items: found.items, next: found.next } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: a cursor from another order is 400, not a restart of the first page', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { seq: 1 });
    await post(svc.base + '/v1/items', { seq: 2 });

    const first = await post(svc.base + '/v1/page', {});
    assert.equal(first.status, 201);
    const page1 = await first.json();
    assert.deepEqual(page1.items.map((item: any) => item.seq), [1], 'the first page is the smallest seq');
    assert.ok(page1.next, 'a cursor follows');

    const other = Buffer.from(JSON.stringify({ v: ['x', 'y'], id: 'x' })).toString('base64url');
    const bad = await post(svc.base + '/v1/page', { cursor: other });
    assert.equal(bad.status, 400, 'a cursor with two values cannot continue a one-field order');
    assert.match(String((await bad.json()).message), /cursor: not a page of this order/);

    const garbage = await post(svc.base + '/v1/page', { cursor: 'not-a-cursor' });
    assert.equal(garbage.status, 400, 'a corrupt cursor is named, not read as "start over"');

    const second = await post(svc.base + '/v1/page', { cursor: page1.next });
    assert.deepEqual((await second.json()).items.map((item: any) => item.seq), [2], 'a real cursor still pages');
  } finally {
    await svc.stop();
  }
});
