// A nullable order field has a rank as well as a value, and the cursor carried
// only values. `col > NULL` is NULL and never true, so a page boundary beside a
// NULL dropped the whole null tail: kv handed it over (its comparator puts NULL
// last on ASC) while MySQL and Postgres stopped one row early, and MySQL also
// sorted the nulls at the other end. The emitters now spell the rank in ORDER
// BY and name it in the keyset clause: ASC ends with NULL, DESC starts with it,
// on all three stores.
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
  const dir = await mkdtemp(join(tmpdir(), 'arcod-keyset-null-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + PREAMBLE + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'title', base: 'string' },
  { name: 'tag', base: 'string' },
];

async function findSql(store: any, query: unknown) {
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 0 };
  };
  await store.entityFind('item', columns, query);
  assert.equal(statements.length, 1, 'one statement per page');
  return statements[0];
}

const cursorOf = (values: unknown[], id: string) =>
  Buffer.from(JSON.stringify({ v: values, id })).toString('base64url');

function orderOf(sql: string) {
  const start = sql.indexOf(' ORDER BY ');
  assert.ok(start > 0, 'the page has an order: ' + sql);
  return sql.slice(start + 10);
}

test('mysql: ASC puts NULL last and the order spells the rank', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const asc = await findSql(store, { order: 'title asc', limit: 2 });
  assert.ok(orderOf(asc).startsWith('(`title` IS NULL) ASC, `title` ASC, `id` ASC'), 'ASC ends with NULL: ' + orderOf(asc));

  const desc = await findSql(store, { order: 'title desc', limit: 2 });
  assert.ok(orderOf(desc).startsWith('(`title` IS NULL) DESC, `title` DESC, `id` ASC'), 'DESC starts with NULL: ' + orderOf(desc));
});

test('mysql: a non-null boundary hands over the null rows after it', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const sql = await findSql(store, { order: 'title asc', limit: 2, cursor: cursorOf(['b'], 'b') });
  assert.match(sql, /\(\(`title` IS NULL\) OR `title` > UNHEX\('62'\)\)/, 'the null tail is still after "b": ' + sql);
  assert.ok(!/`title` > NULL/.test(sql), 'a null never becomes a comparison');
});

test('mysql: a null boundary continues with the remaining null rows', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const sql = await findSql(store, { order: 'title asc', limit: 2, cursor: cursorOf([null], 'b') });
  assert.match(sql, /`title` <=> NULL AND `id` > UNHEX\('62'\)/, 'NULL rows tie and id continues: ' + sql);
  assert.ok(!/`title` (?:<|>) NULL/.test(sql), 'a null boundary never compares against NULL');
});

test('mysql: a null boundary on DESC releases the non-null rows', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const sql = await findSql(store, { order: 'title desc', limit: 2, cursor: cursorOf([null], 'b') });
  assert.match(sql, /`title` IS NOT NULL/, 'DESC starts with NULL, so every named row follows: ' + sql);
});

test('postgres: the order spells the rank and the null tail is reachable', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://localhost:5432/arcod');

  const asc = await findSql(store, { order: 'title asc', limit: 2 });
  assert.ok(orderOf(asc).startsWith('("title" IS NULL) ASC, "title" ASC, "id" ASC'), 'ASC ends with NULL: ' + orderOf(asc));

  const tail = await findSql(store, { order: 'title asc', limit: 2, cursor: cursorOf(['b'], 'b') });
  assert.match(tail, /\(\("title" IS NULL\) OR "title" > 'b'\)/, 'the null rows follow "b": ' + tail);

  const inside = await findSql(store, { order: 'title asc', limit: 2, cursor: cursorOf([null], 'b') });
  assert.match(inside, /"title" IS NOT DISTINCT FROM NULL AND "id" > 'b'/, 'NULL rows tie and id continues: ' + inside);

  const desc = await findSql(store, { order: 'title desc', limit: 2, cursor: cursorOf([null], 'b') });
  assert.match(desc, /"title" IS NOT NULL/, 'a null boundary on DESC releases the non-null rows: ' + desc);
});

test('mysql: a later column of a NULL boundary keeps its own rank', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const sql = await findSql(store, {
    order: 'tag asc, title desc',
    limit: 2,
    cursor: cursorOf(['x', null], 'b'),
  });
  assert.match(sql, /`tag` <=> UNHEX\('78'\) AND `title` IS NOT NULL/, 'the tie prefix stays null-safe: ' + sql);
});

// The kv store already compared NULL last on ASC and first on DESC; this is the
// contract the SQL stores now share, so it is worth one end-to-end page over a
// nullable field: the page boundary lands on a value, the null tail still comes.
const spec = [
  'module nullable @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type ItemId = uuid',
  'type Item = { id: ItemId, tag: string, rank: int? }',
  '',
  'error Invalid',
  '',
  'service Nullable : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tag: string, rank: int?) -> { id: ItemId } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op page(limit: int, cursor: string?) -> { items: list<Item>, next: string? } {',
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
    '  const record = { id: io.new(), tag: String(input.tag) };',
    '  if (input.rank !== null && input.rank !== undefined) record.rank = Number(input.rank);',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  page: [
    'export async function page(input, io) {',
    '  const options = { order: "rank asc", limit: Number(input.limit) || 2 };',
    '  if (input.cursor) options.cursor = String(input.cursor);',
    '  const found = await io.find("Item", options);',
    '  return { result: { items: found.items, next: found.next } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: a page boundary inside the named ranks still hands over the null tail', async () => {
  const svc = await startService(spec, { impl });
  try {
    for (const rank of [30, 10]) await post(svc.base + '/v1/items', { tag: 'a', rank });
    for (let index = 0; index < 2; index += 1) await post(svc.base + '/v1/items', { tag: 'a', rank: null });

    const first = await post(svc.base + '/v1/page', { limit: 1 });
    assert.equal(first.status, 201);
    const page1 = await first.json();
    assert.deepEqual(page1.items.map((item: any) => item.rank), [10], 'ASC starts with the smallest named rank');
    assert.ok(page1.next, 'more rows produce a cursor');

    const seen: any[] = [...page1.items];
    let cursor = page1.next;
    for (let guard = 0; guard < 5 && cursor; guard += 1) {
      const response = await post(svc.base + '/v1/page', { limit: 1, cursor });
      assert.equal(response.status, 201);
      const page = await response.json();
      seen.push(...page.items);
      cursor = page.next;
    }

    const ranks = seen.map((item: any) => (item.rank === undefined ? null : item.rank));
    assert.deepEqual(ranks, [10, 30, null, null], 'named ranks first, the null tail last, nothing twice');
    assert.equal(cursor, null, 'the last page has no cursor');
  } finally {
    await svc.stop();
  }
});
