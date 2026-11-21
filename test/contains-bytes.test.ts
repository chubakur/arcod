// bytes has no text form: kv holds the value as stored, MySQL casts the BLOB
// to its raw bytes and Postgres renders a bytea escape ("\x68\x69"), so the
// same contains query matched three different things. The filter is refused
// with the field named; eq/ne/in compare the value itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, at: datetime, blob: bytes }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(at: datetime, blob: bytes) -> { id: uuid } {',
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
    '  const record = { id: io.new(), at: input.at, blob: input.blob };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "eq");',
    '  const where = mode === "contains"',
    '    ? { blob: { contains: "hi" } }',
    '    : mode === "containsHex"',
    '      ? { blob: { contains: "68" } }',
    '      : { blob: { eq: "hi" } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: contains on a bytes field is 400, eq still compares the value', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { at: '2026-01-01T00:00:00Z', blob: 'hi' });
    assert.equal(put.status, 201, 'seed insert succeeds');

    for (const mode of ['contains', 'containsHex']) {
      const bad = await post(svc.base + '/v1/scan', { mode });
      assert.equal(bad.status, 400, 'contains on bytes is Invalid (' + mode + ')');
      const error = await bad.json();
      assert.match(
        String(error.message),
        /where "contains" on "blob" needs text, and a bytes field has none: kv holds the bytes, MySQL the raw BLOB and Postgres a bytea escape; compare bytes with eq\/ne\/in/
      );
    }

    const eq = await post(svc.base + '/v1/scan', { mode: 'eq' });
    assert.equal(eq.status, 201);
    assert.equal((await eq.json()).items.length, 1, 'eq compares the bytes themselves');
  } finally {
    await svc.stop();
  }
});

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
  const dir = await mkdtemp(join(tmpdir(), 'arcod-contains-bytes-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + PREAMBLE + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'blob', base: 'bytes' },
];

async function rejectsContains(store: any, statements: string[]) {
  await assert.rejects(
    () => store.entityCount('item', columns, { where: { blob: { contains: 'hi' } } }),
    (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.match(
        String(error.message),
        /where "contains" on "blob" needs text, and a bytes field has none: kv holds the bytes, MySQL the raw BLOB and Postgres a bytea escape; compare bytes with eq\/ne\/in/
      );
      return true;
    }
  );
  assert.equal(statements.length, 0, 'a rejected query never reaches the driver');
}

test('mysql: contains on a bytes field never reaches the driver', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await rejectsContains(store, statements);

  await store.entityCount('item', columns, { where: { blob: { eq: 'hi' } } });
  assert.match(statements[0], /WHERE .*blob.* = /, 'eq still builds its clause: ' + statements[0]);
});

test('postgres: contains on a bytes field never reaches the driver', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://localhost:5432/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await rejectsContains(store, statements);

  await store.entityCount('item', columns, { where: { blob: { eq: 'hi' } } });
  assert.match(statements[0], /WHERE .*blob.* = /, 'eq still builds its clause: ' + statements[0]);
});
