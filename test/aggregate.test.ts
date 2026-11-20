import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

// A report that sums invoices must not read rows: an aggregate is one statement
// on sql and one pass on the memory driver, and the answer never depends on a
// page size. An unknown op is an error, not a quiet undefined.

const spec = [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.sql @1',
  'use capability arcod.std.ids @1',
  '',
  'type EntryId = uuid',
  'type Entry = { id: EntryId, amount: int, kind: string }',
  '',
  'error Invalid',
  '',
  'service Ledger : http {',
  '  uses store: sql',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.aggregate, store.count, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op seed(n: int, kind: string) -> { n: int } {',
  '      route: "POST /v1/seed"',
  '      effects: store.insert',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op total(kind: string?) -> { sum: int, avg: float, count: int } {',
  '      route: "GET /v1/total"',
  '      effects: store.aggregate, store.count',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op broken() -> { sum: int } {',
  '      route: "GET /v1/broken"',
  '      effects: store.aggregate',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  seed: [
    'export async function seed(input, io) {',
    '  const n = Number(input.n);',
    '  const kind = String(input.kind || "a");',
    '  for (let index = 1; index <= n; index += 1) {',
    '    await io.insert("Entry", { id: io.new(), amount: index, kind });',
    '  }',
    '  return { result: { n } };',
    '}',
  ].join('\n'),
  total: [
    'export async function total(input, io) {',
    '  const where = input.kind ? { kind: String(input.kind) } : null;',
    '  const sum = await io.aggregate("Entry", { field: "amount", op: "sum", where });',
    '  const avg = await io.aggregate("Entry", { field: "amount", op: "avg", where });',
    '  const count = await io.count("Entry", { where });',
    '  return { result: { sum, avg, count } };',
    '}',
  ].join('\n'),
  broken: [
    'export async function broken(input, io) {',
    '  const sum = await io.aggregate("Entry", { field: "amount", op: "median" });',
    '  return { result: { sum } };',
    '}',
  ].join('\n'),
};

test('aggregate sums 1200 records without a page and matches the reference', async () => {
  const svc = await startService(spec, { impl });
  try {
    const seeded = await fetch(svc.base + '/v1/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1200, kind: 'a' }),
    });
    assert.equal(seeded.status, 201);

    const total = await (await fetch(svc.base + '/v1/total')).json();
    assert.equal(total.count, 1200);
    assert.equal(total.sum, (1200 * 1201) / 2);
    assert.equal(total.avg, (1200 + 1) / 2);

    // The same predicate count uses filters the aggregate.
    const filtered = await (await fetch(svc.base + '/v1/total?kind=b')).json();
    assert.equal(filtered.count, 0);
    assert.equal(filtered.sum, 0, 'sum of nothing is 0');
    assert.equal(filtered.avg, null, 'avg of nothing is null');
  } finally {
    await svc.stop();
  }
});

test('an unknown aggregate op is a 400 with the op named', async () => {
  const svc = await startService(spec, { impl });
  try {
    const res = await fetch(svc.base + '/v1/broken');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Invalid');
    assert.match(body.message, /unknown op .median./);
  } finally {
    await svc.stop();
  }
});

// The sql paths run against the emitted store source with a fake connection:
// exactly one statement must reach the driver, and it must be the aggregate.
// The store source is emitted next to the service runtime, which owns
// ArcodError; a standalone load needs that one definition.
const ARC = [
  'function ArcodError(name, fields) {',
  '  this.name = name;',
  '  this.error = name;',
  '  this.message = name;',
  "  if (fields && typeof fields === 'object') {",
  '    for (const key of Object.keys(fields)) this[key] = fields[key];',
  '  }',
  '}',
  'ArcodError.prototype = Object.create(Error.prototype);',
  'ArcodError.prototype.constructor = ArcodError;',
].join(String.fromCharCode(10));

async function loadStore(source: string, name: string, extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-agg-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + extra + source + '\nexport { ' + name + ' };\n', 'utf8');
  return await import(pathToFileURL(file).href);
}

test('mysql aggregate is one SUM statement with the find predicates', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [['42']], affected: 0 };
  };
  const columns = [
    { name: 'id', base: 'string' },
    { name: 'amount', base: 'int' },
    { name: 'kind', base: 'string' },
  ];
  const value = await store.entityAggregate('entry', columns, { field: 'amount', op: 'sum', where: { kind: 'a' } });
  assert.equal(value, 42);
  assert.equal(statements.length, 1, 'one statement, no page');
  assert.match(statements[0], /^SELECT SUM\(.amount.\) AS v FROM .entry. WHERE .kind. = /);

  const rejectsWith = (run: () => Promise<unknown>, pattern: RegExp) =>
    assert.rejects(run, (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.match(String(error.message), pattern);
      return true;
    });
  await rejectsWith(() => store.entityAggregate('entry', columns, { field: 'amount', op: 'median' }), /unknown op .median./);
  await rejectsWith(() => store.entityAggregate('entry', columns, { field: 'nope', op: 'sum' }), /unknown field .nope./);
  assert.equal(statements.length, 1, 'a rejected op never reaches the driver');
});

test('postgres aggregate quotes like every other statement', async () => {
  const { PG_SQL_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://user:pass@localhost:5432/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [['7']], affected: 0 };
  };
  const columns = [
    { name: 'id', base: 'string' },
    { name: 'amount', base: 'int' },
  ];
  const value = await store.entityAggregate('entry', columns, { field: 'amount', op: 'max' });
  assert.equal(value, 7);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^SELECT MAX\(.amount.\) AS v FROM .entry.$/);
});
