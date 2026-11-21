// A row whose field has no value is not a row with a value: SQL answers NULL
// for `col <> 'x'` when col is NULL, so the row never matches. kv read an
// absent field as "different from x" and returned those rows -- and an empty
// contains matched them too (' '.includes('')). The kv matcher now applies the
// SQL rule once, before any operator, so ne/in/contains answer the same as SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

const spec = [
  'module nullable @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type ItemId = uuid',
  'type Item = { id: ItemId, tag: string, note: string? }',
  '',
  'error Invalid',
  '',
  'service NullableWhere : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tag: string, note: string?) -> { id: ItemId } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op scan(mode: string) -> { items: list<Item> } {',
  '      route: "POST /v1/scan"',
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
    '  const record = { id: io.new(), tag: String(input.tag) };',
    '  if (input.note !== null && input.note !== undefined) record.note = String(input.note);',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "ne");',
    '  const where = mode === "ne"',
    '    ? { note: { ne: "x" } }',
    '    : mode === "empty"',
    '      ? { note: { contains: "" } }',
    '      : mode === "inNull"',
    '        ? { note: { in: [null, "x"] } }',
    '        : { note: { eq: "x" } };',
    '  const found = await io.find("Item", { where });',
    '  return { result: { items: found.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: ne and contains never match a row whose nullable field is absent', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a', note: 'x' });
    await post(svc.base + '/v1/items', { tag: 'a', note: 'y' });
    await post(svc.base + '/v1/items', { tag: 'a', note: null });

    const notes = async (mode: string) => {
      const response = await post(svc.base + '/v1/scan', { mode });
      assert.equal(response.status, 201, mode + ' is a valid filter');
      const body = await response.json();
      return body.items.map((item: any) => (item.note === undefined ? null : item.note)).sort();
    };

    assert.deepEqual(await notes('ne'), ['y'], 'ne means "has a value and it is not x"');
    assert.deepEqual(await notes('empty'), ['x', 'y'], 'contains never matches an absent field');
    assert.deepEqual(await notes('inNull'), ['x'], 'a null in the list does not match an absent field');
    assert.deepEqual(await notes('eq'), ['x'], 'eq already agreed');
  } finally {
    await svc.stop();
  }
});

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

async function loadStore(source: string, name: string) {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-where-null-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, PREAMBLE + String.fromCharCode(10) + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

test('mysql: ne stays a plain inequality, so SQL itself never matches a NULL', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 0 };
  };
  const columns = [{ name: 'id', base: 'string' }, { name: 'note', base: 'string' }];
  await store.entityFind('item', columns, { where: { note: { ne: 'x' } } });
  assert.match(statements[0], /`note` <> UNHEX\('78'\)/, 'the clause is the inequality the row must satisfy: ' + statements[0]);
  assert.ok(!/`note` IS NULL/.test(statements[0]), 'no rewrite that would readmit the null rows');
});
