// bytes and the non-integer numbers have no text form both stores share: kv
// holds the value as stored, MySQL casts the BLOB to raw bytes and DECIMAL(30,6)
// to "1.500000", Postgres renders a bytea escape and its own exponent. The same
// contains query matched three different things, so the filter is refused with
// the field named; eq/ne/in and a range compare the value itself. An int keeps
// contains: its text is the number on every store.
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
  'type Item = { id: uuid, at: datetime, blob: bytes, price: decimal, ratio: float }',
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
  '    public op put(at: datetime, blob: bytes, price: decimal, ratio: float) -> { id: uuid } {',
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
    '  const record = { id: io.new(), at: input.at, blob: input.blob, price: input.price, ratio: input.ratio };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "eq");',
    '  const where = mode === "bytes"',
    '    ? { blob: { contains: "hi" } }',
    '    : mode === "bytesHex"',
    '      ? { blob: { contains: "68" } }',
    '      : mode === "decimal"',
    '        ? { price: { contains: "1.5" } }',
    '        : mode === "float"',
    '          ? { ratio: { contains: "0.5" } }',
    '          : mode === "eqBytes"',
    '            ? { blob: { eq: "hi" } }',
    '            : { price: { eq: 1.5 } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const numberRefusal = (field: string, base: string) =>
  'where "contains" on "' + field + '" searches text, and a ' + base + ' column has no stable text: each store picks its own scale and exponent; compare numbers with eq/ne/in or a range';

const bytesRefusal =
  'where "contains" on "blob" needs text, and a bytes field has none: kv holds the bytes, MySQL the raw BLOB and Postgres a bytea escape; compare bytes with eq/ne/in';

test('kv: contains on bytes, decimal and float is 400, equality still compares the value', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { at: '2026-01-01T00:00:00Z', blob: 'hi', price: 1.5, ratio: 0.5 });
    assert.equal(put.status, 201, 'seed insert succeeds');

    const cases = [
      ['bytes', bytesRefusal],
      ['bytesHex', bytesRefusal],
      ['decimal', numberRefusal('price', 'decimal')],
      ['float', numberRefusal('ratio', 'float')],
    ] as const;
    for (const [mode, expected] of cases) {
      const bad = await post(svc.base + '/v1/scan', { mode });
      assert.equal(bad.status, 400, 'contains with no text form is Invalid (' + mode + ')');
      assert.equal(String((await bad.json()).message), expected);
    }

    const bytesEq = await post(svc.base + '/v1/scan', { mode: 'eqBytes' });
    assert.equal(bytesEq.status, 201);
    assert.equal((await bytesEq.json()).items.length, 1, 'eq compares the bytes themselves');

    const priceEq = await post(svc.base + '/v1/scan', { mode: 'eqPrice' });
    assert.equal(priceEq.status, 201);
    assert.equal((await priceEq.json()).items.length, 1, 'eq compares the number itself');
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
  const dir = await mkdtemp(join(tmpdir(), 'arcod-contains-non-text-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + PREAMBLE + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'blob', base: 'bytes' },
  { name: 'price', base: 'decimal' },
  { name: 'ratio', base: 'float' },
];

async function rejects(store: any, statements: string[], where: unknown, expected: string) {
  await assert.rejects(
    () => store.entityCount('item', columns, { where }),
    (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.equal(String(error.message), expected);
      return true;
    }
  );
  assert.equal(statements.length, 0, 'a rejected query never reaches the driver');
}

async function checkSqlStore(store: any) {
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await rejects(store, statements, { blob: { contains: 'hi' } }, bytesRefusal);
  await rejects(store, statements, { price: { contains: '1.5' } }, numberRefusal('price', 'decimal'));
  await rejects(store, statements, { ratio: { contains: '0.5' } }, numberRefusal('ratio', 'float'));

  await store.entityCount('item', columns, { where: { price: { eq: 1.5 } } });
  assert.match(statements[0], /WHERE .*price.* = /, 'eq still builds its clause: ' + statements[0]);
}

test('mysql: contains with no text form never reaches the driver', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  await checkSqlStore(new SqlStore('mysql://localhost:3306/arcod'));
});

test('postgres: contains with no text form never reaches the driver', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  await checkSqlStore(new PgStore('postgres://localhost:5432/arcod'));
});
