// contains on a moment used to be a text search over three different
// spellings: kv held "2026-01-01T00:00:00Z", MySQL "2026-01-01 00:00:00.000"
// and Postgres "2026-01-01 00:00:00". The same query therefore found different
// rows on different stores ("T00" only kv, a space only SQL, ".000" only
// MySQL). A moment has an order, so the filter is a range, and contains on a
// datetime is Invalid with the field named on every driver.
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
  'type Item = { id: uuid, at: datetime }',
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
  '    public op put(at: datetime) -> { id: uuid } {',
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
    '  const record = { id: io.new(), at: input.at };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "range");',
    '  const where = mode === "contains"',
    '    ? { at: { contains: "2026-01-01" } }',
    '    : mode === "containsT"',
    '      ? { at: { contains: "T00:00" } }',
    '      : { at: { gte: "2026-01-01T00:00:00Z" } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: contains on a datetime is 400, a range still filters', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { at: '2026-01-01T00:00:00Z' });
    assert.equal(put.status, 201, 'seed insert succeeds');

    for (const mode of ['contains', 'containsT']) {
      const bad = await post(svc.base + '/v1/scan', { mode });
      assert.equal(bad.status, 400, 'contains on a datetime is Invalid (' + mode + ')');
      const error = await bad.json();
      assert.match(
        String(error.message),
        /where "contains" on "at" searches text, and a datetime is spelled differently by each store; use gt\/gte\/lt\/lte/
      );
    }

    const range = await post(svc.base + '/v1/scan', { mode: 'range' });
    assert.equal(range.status, 201);
    const page = await range.json();
    assert.equal(page.items.length, 1, 'a range names the same window on every store');
  } finally {
    await svc.stop();
  }
});

// The emitted stores run standalone with a fake connection: a rejected filter
// must never reach the driver, and a range must still build its clause.
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
  const dir = await mkdtemp(join(tmpdir(), 'arcod-contains-datetime-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + PREAMBLE + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'at', base: 'datetime' },
];

async function rejectsContains(store: any, statements: string[]) {
  await assert.rejects(
    () => store.entityCount('item', columns, { where: { at: { contains: '2026-01-01' } } }),
    (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.match(
        String(error.message),
        /where "contains" on "at" searches text, and a datetime is spelled differently by each store; use gt\/gte\/lt\/lte/
      );
      return true;
    }
  );
  assert.equal(statements.length, 0, 'a rejected query never reaches the driver');
}

test('mysql: contains on a datetime never reaches the driver', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await rejectsContains(store, statements);

  await store.entityCount('item', columns, { where: { at: { gte: '2026-01-01T00:00:00Z' } } });
  assert.match(statements[0], /WHERE .*at.* >= /, 'a range still builds its clause: ' + statements[0]);
});

test('postgres: contains on a datetime never reaches the driver', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://localhost:5432/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await rejectsContains(store, statements);

  await store.entityCount('item', columns, { where: { at: { gte: '2026-01-01T00:00:00Z' } } });
  assert.match(statements[0], /WHERE .*at.* >= /, 'a range still builds its clause: ' + statements[0]);
});
