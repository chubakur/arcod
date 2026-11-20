import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

// where: { field: { in: ... } } used to mean two different things: on sql a
// non-list value fell through the operator chain and the clause vanished (the
// query returned every row), on kv the same query answered an empty page, and
// an empty list produced IN () - a syntax error the service reported as 500.
// Both drivers now answer 400 with the field and the received type, and an
// empty list is a filter that matches nothing.

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type ItemId = uuid',
  'type Item = { id: ItemId, tag: string, note: string?, tags: list<string>, size: int }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, store.count, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tag: string) -> { id: ItemId } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op scan(mode: string) -> { items: list<Item>, count: int } {',
  '      route: "POST /v1/scan"',
  '      effects: store.find, store.count',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  put: [
    'export async function put(input, io) {',
    '  const record = { id: io.new(), tag: String(input.tag), tags: ["a", "b"], size: 42 };',
    '  if (input.tag === "extra") record.typo = 1;',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "ok");',
    '  const where = mode === "empty"',
    '    ? { tag: { in: [] } }',
    '    : mode === "bad"',
    '      ? { tag: { in: "a" } }',
    '      : mode === "typo"',
    '        ? { nmae: { in: ["a"] } }',
    '        : mode === "nullcmp"',
    '          ? { tag: { eq: null } }',
    '          : mode === "absent"',
    '            ? { note: { gt: "a" } }',
    '            : mode === "list"',
    '              ? { tags: { eq: ["a", "b"] } }',
    '              : mode === "listother"',
    '                ? { tags: { eq: ["b", "a"] } }',
    '                : mode === "contains"',
    '                  ? { size: { contains: "4" } }',
    '                  : mode === "containsnone"',
    '                    ? { size: { contains: "9" } }',
    '                    : { tag: { in: ["a", "b"] } };',
    '  const order = mode === "order" ? "nmae asc" : undefined;',
    '  const page = await io.find("Item", { where, order });',
    '  const count = await io.count("Item", { where });',
    '  return { result: { items: page.items, count } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: "in" with a scalar is 400 and an empty list matches nothing', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { tag: 'a' });
    assert.equal(put.status, 201, 'seed insert succeeds');

    const bad = await post(svc.base + '/v1/scan', { mode: 'bad' });
    assert.equal(bad.status, 400, 'a non-list under "in" is Invalid, not an empty page');
    const error = await bad.json();
    assert.match(String(error.message), /where "in" on "tag" needs a list, got string/);

    const empty = await post(svc.base + '/v1/scan', { mode: 'empty' });
    assert.equal(empty.status, 201, 'an empty list is a legal filter (POST answers 201)');
    const emptyPage = await empty.json();
    assert.equal(emptyPage.count, 0, 'nothing matches an empty list');
    assert.deepEqual(emptyPage.items, [], 'and the page is empty');

    const ok = await post(svc.base + '/v1/scan', { mode: 'ok' });
    assert.equal(ok.status, 201);
    const page = await ok.json();
    assert.equal(page.count, 1, 'the seeded tag is found through "in"');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].tag, 'a');
  } finally {
    await svc.stop();
  }
});

// The emitted stores run standalone with a fake connection: the statement is
// what the driver would see, so a dropped clause is visible as a missing
// WHERE instead of a wrong page.
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
  const dir = await mkdtemp(join(tmpdir(), 'arcod-where-in-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

// entityFind leans on the cursor/order helpers that the service prepends to the
// store body; mirror just those three so the store can run standalone.
const PREAMBLE = [
  'function parseOrder(order) {',
  "  const list = Array.isArray(order) ? order : String(order || 'id').split(',');",
  '  return list.map((entry) => {',
  "    const parts = String(entry).trim().split(/\\s+/);",
  "    return { field: parts[0], dir: (parts[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1 };",
  '  });',
  '}',
  'function encodeCursor(values, id) {',
  "  return Buffer.from(JSON.stringify({ v: values, id })).toString('base64url');",
  '}',
  'function decodeCursor(cursor) {',
  '  try {',
  "    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));",
  '  } catch {',
  '    return null;',
  '  }',
  '}',
].join(String.fromCharCode(10));

const columns = [
  { name: 'id', base: 'string' },
  { name: 'tag', base: 'string' },
];

test('mysql: "in" keeps its clause, rejects a scalar and inlines an empty list', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await assert.rejects(
    () => store.entityCount('item', columns, { where: { tag: { in: 'a' } } }),
    (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.match(String(error.message), /where "in" on "tag" needs a list, got string/);
      return true;
    }
  );
  assert.equal(statements.length, 0, 'a rejected query never reaches the driver');

  await store.entityCount('item', columns, { where: { tag: { in: [] } } });
  assert.match(statements[0], /WHERE 1 = 0$/, 'an empty list is a false predicate: ' + statements[0]);

  await store.entityCount('item', columns, { where: { tag: { in: ['a', 'b'] } } });
  assert.match(
    statements[1],
    /WHERE `tag` IN \(UNHEX\('61'\), UNHEX\('62'\)\)$/,
    'both values stay in the IN list: ' + statements[1]
  );
});

test('postgres: "in" behaves like mysql', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://user:pass@localhost:5432/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };

  await assert.rejects(
    () => store.entityCount('item', columns, { where: { tag: { in: 7 } } }),
    (error: any) => {
      assert.equal(error.name, 'Invalid');
      assert.match(String(error.message), /where "in" on "tag" needs a list, got number/);
      return true;
    }
  );
  assert.equal(statements.length, 0);

  await store.entityCount('item', columns, { where: { tag: { in: [] } } });
  assert.match(statements[0], /WHERE 1 = 0$/, 'an empty list is a false predicate: ' + statements[0]);

  await store.entityCount('item', columns, { where: { tag: { in: ['a'] } } });
  assert.match(statements[1], /WHERE "tag" IN \('a'\)$/, 'the value stays quoted: ' + statements[1]);
});

test('kv: a where key the entity does not declare is 400, not an empty page', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a' });
    const typo = await post(svc.base + '/v1/scan', { mode: 'typo' });
    assert.equal(typo.status, 400, 'a typo is Invalid on kv too');
    const error = await typo.json();
    assert.match(String(error.message), /where: unknown field "nmae"; declared: id, tag/);
  } finally {
    await svc.stop();
  }
});

test('sql: a where key the entity does not declare never reaches the driver', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const mysql = await loadStore(SQL_STORE_SOURCE, 'SqlStore', PREAMBLE);
  const pg = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE + PREAMBLE);
  const checks: Array<[string, any]> = [
    ['mysql', new mysql.SqlStore('mysql://localhost:3306/arcod')],
    ['postgres', new pg.PgStore('postgres://user:pass@localhost:5432/arcod')],
  ];
  for (const [dialect, store] of checks) {
    const statements: string[] = [];
    store.query = async (sql: string) => {
      statements.push(sql);
      return { rows: [[1]], affected: 0 };
    };
    for (const run of [
      () => store.entityFind('item', columns, { where: { nmae: 'a' } }),
      () => store.entityCount('item', columns, { where: { nmae: 'a' } }),
      () => store.entityAggregate('item', columns, { field: 'tag', op: 'sum', where: { nmae: 'a' } }),
    ]) {
      await assert.rejects(run, (error: any) => {
        assert.equal(error.name, 'Invalid', dialect);
        assert.match(String(error.message), /where: unknown field "nmae"; declared: id, tag/, dialect);
        return true;
      });
    }
    assert.equal(statements.length, 0, dialect + ': no statement carries an unknown field');
  }
});

test('order: an unknown sort field is 400 on kv and names the columns', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a' });
    const bad = await post(svc.base + '/v1/scan', { mode: 'order' });
    assert.equal(bad.status, 400, 'a typo in order is Invalid, not a silent no-op sort');
    const error = await bad.json();
    assert.match(String(error.message), /order: unknown field "nmae"; declared: id, tag/);
  } finally {
    await svc.stop();
  }
});

test('order: sql rejects an unknown column instead of 500, and keeps a valid one', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const mysql = await loadStore(SQL_STORE_SOURCE, 'SqlStore', PREAMBLE);
  const pg = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE + PREAMBLE);
  const checks: Array<[string, any]> = [
    ['mysql', new mysql.SqlStore('mysql://localhost:3306/arcod')],
    ['postgres', new pg.PgStore('postgres://user:pass@localhost:5432/arcod')],
  ];
  for (const [dialect, store] of checks) {
    const statements: string[] = [];
    store.query = async (sql: string) => {
      statements.push(sql);
      return { rows: [], affected: 0 };
    };
    await assert.rejects(
      () => store.entityFind('item', columns, { order: 'nmae asc' }),
      (error: any) => {
        assert.equal(error.name, 'Invalid', dialect);
        assert.match(String(error.message), /order: unknown field "nmae"; declared: id, tag/, dialect);
        return true;
      }
    );
    assert.equal(statements.length, 0, dialect + ': the driver never sees an unknown ORDER BY');
    await store.entityFind('item', columns, { order: 'tag desc' });
    assert.match(statements[0], /ORDER BY .tag. DESC/, dialect + ': a declared field still sorts');
  }
});

test('kv: comparing with null is 400, and a null cell never matches an order filter', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a' });
    const nullcmp = await post(svc.base + '/v1/scan', { mode: 'nullcmp' });
    assert.equal(nullcmp.status, 400, 'eq: null is Invalid, not a silent empty page');
    assert.match(String((await nullcmp.json()).message), /where "eq" on "tag" compares with null/);

    const absent = await post(svc.base + '/v1/scan', { mode: 'absent' });
    assert.equal(absent.status, 201);
    const page = await absent.json();
    assert.equal(page.count, 0, 'a record without the field is not greater than a value');
    assert.deepEqual(page.items, []);
  } finally {
    await svc.stop();
  }
});

test('sql: comparing with null is rejected before the driver sees the clause', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const mysql = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const pg = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const checks: Array<[string, any]> = [
    ['mysql', new mysql.SqlStore('mysql://localhost:3306/arcod')],
    ['postgres', new pg.PgStore('postgres://user:pass@localhost:5432/arcod')],
  ];
  for (const [dialect, store] of checks) {
    const statements: string[] = [];
    store.query = async (sql: string) => {
      statements.push(sql);
      return { rows: [[0]], affected: 0 };
    };
    await assert.rejects(
      () => store.entityCount('item', columns, { where: { tag: { eq: null } } }),
      (error: any) => {
        assert.equal(error.name, 'Invalid', dialect);
        assert.match(String(error.message), /where "eq" on "tag" compares with null/, dialect);
        return true;
      }
    );
    assert.equal(statements.length, 0, dialect + ': no NULL comparison reaches the driver');
    await store.entityCount('item', columns, { where: { tag: 'a' } });
    assert.doesNotMatch(statements[0], /NULL/, dialect);
  }
});

test('kv: a list field compares by value, like the json text on sql', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a' });
    const same = await post(svc.base + '/v1/scan', { mode: 'list' });
    assert.equal(same.status, 201);
    assert.equal((await same.json()).count, 1, 'the same list is found by eq');
    const other = await post(svc.base + '/v1/scan', { mode: 'listother' });
    assert.equal((await other.json()).count, 0, 'a different order is a different list');
  } finally {
    await svc.stop();
  }
});

test('contains: works on a numeric field on kv, and sql casts the column to text', async () => {
  const svc = await startService(spec, { impl });
  try {
    await post(svc.base + '/v1/items', { tag: 'a' });
    const hit = await post(svc.base + '/v1/scan', { mode: 'contains' });
    assert.equal((await hit.json()).count, 1, 'a substring of a number matches on kv');
    const miss = await post(svc.base + '/v1/scan', { mode: 'containsnone' });
    assert.equal((await miss.json()).count, 0);
  } finally {
    await svc.stop();
  }

  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const mysql = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const pg = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const checks: Array<[string, any, RegExp]> = [
    ['mysql', new mysql.SqlStore('mysql://localhost:3306/arcod'), /CAST\(.size. AS CHAR\) LIKE/],
    ['postgres', new pg.PgStore('postgres://user:pass@localhost:5432/arcod'), /CAST\("size" AS text\) LIKE/],
  ];
  const withSize = [{ name: 'id', base: 'string' }, { name: 'size', base: 'int' }];
  for (const [dialect, store, pattern] of checks) {
    const statements: string[] = [];
    store.query = async (sql: string) => {
      statements.push(sql);
      return { rows: [[1]], affected: 0 };
    };
    await store.entityCount('item', withSize, { where: { size: { contains: '4' } } });
    assert.match(statements[0], pattern, dialect + ': LIKE needs a text cast');
  }
});

test('insert: a record field the entity does not declare is 400, not silently dropped', async () => {
  const svc = await startService(spec, { impl });
  try {
    const extra = await post(svc.base + '/v1/items', { tag: 'extra' });
    assert.equal(extra.status, 400, 'an undeclared field is a mistake, not data');
    assert.match(String((await extra.json()).message), /insert Item: unknown field "typo"; declared: id, tag/);
  } finally {
    await svc.stop();
  }


});
