// LIKE has its own grammar: % matches any run, _ any one character, and a
// backslash escapes. A caller searching for "100%" asked for a percent sign,
// but mysql and postgres both read that as "starts with 100" -- so the same
// filter answered one row on kv (which compares text) and every 100-something
// row on sql. The needle is escaped with '!' and the clause names it, so a
// pattern only ever means itself on both drivers.
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

async function loadStore(source: string, name: string, extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-like-escape-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, ARC + String.fromCharCode(10) + extra + source + String.fromCharCode(10) + 'export { ' + name + ' };' + String.fromCharCode(10), 'utf8');
  return await import(pathToFileURL(file).href);
}

const columns = [
  { name: 'id', base: 'string' },
  { name: 'note', base: 'string' },
];

async function clause(store: any, needle: string) {
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [[0]], affected: 0 };
  };
  await store.entityCount('item', columns, { where: { note: { contains: needle } } });
  assert.equal(statements.length, 1, 'one count query');
  return statements[0];
}

test('mysql: contains escapes % and _ and names the escape character', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { SqlStore } = await loadStore(SQL_STORE_SOURCE, 'SqlStore');
  const store = new SqlStore('mysql://localhost:3306/arcod');

  const sql = await clause(store, '100%');
  assert.match(sql, / ESCAPE '!'/, 'the ESCAPE clause names the escape character: ' + sql);
  const hex = /UNHEX\('([0-9a-f]+)'\)/.exec(sql);
  assert.ok(hex, 'the pattern travels as a hex literal: ' + sql);
  assert.equal(Buffer.from(hex![1], 'hex').toString('utf8'), '%100!%%');

  const both = await clause(store, 'a_b%c');
  const hex2 = /UNHEX\('([0-9a-f]+)'\)/.exec(both)!;
  assert.equal(Buffer.from(hex2[1], 'hex').toString('utf8'), '%a!_b!%c%');

  const bang = await clause(store, 'no!');
  const hex3 = /UNHEX\('([0-9a-f]+)'\)/.exec(bang)!;
  assert.equal(Buffer.from(hex3[1], 'hex').toString('utf8'), '%no!!%', 'the escape character escapes itself');

  const plain = await clause(store, 'tea');
  const hex4 = /UNHEX\('([0-9a-f]+)'\)/.exec(plain)!;
  assert.equal(Buffer.from(hex4[1], 'hex').toString('utf8'), '%tea%', 'a plain needle is unchanged');
});

test('postgres: contains escapes % and _ and names the escape character', async () => {
  const { PG_SQL_STORE_SOURCE, PG_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { PgStore } = await loadStore(PG_SQL_STORE_SOURCE, 'PgStore', PG_STORE_SOURCE);
  const store = new PgStore('postgres://localhost:5432/arcod');

  const sql = await clause(store, '100%');
  assert.match(sql, /LIKE '%100!%%' ESCAPE '!'/, 'the pattern is escaped and the escape named: ' + sql);

  const both = await clause(store, 'a_b%c');
  assert.match(both, /LIKE '%a!_b!%c%' ESCAPE '!'/, 'both wildcards are escaped: ' + both);
});

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, note: string }',
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
  '    public op put(note: string) -> { id: uuid } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op scan(needle: string) -> { items: list<Item> } {',
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
    '  const record = { id: io.new(), note: String(input.note) };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const page = await io.find("Item", { where: { note: { contains: String(input.needle) } } });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: contains reads % and _ as themselves', async () => {
  const svc = await startService(spec, { impl });
  try {
    for (const note of ['100% cotton', '100 cotton', '50% off', 'a_b', 'axb']) {
      const put = await post(svc.base + '/v1/items', { note });
      assert.equal(put.status, 201, 'seed ' + note);
    }

    const pct = await post(svc.base + '/v1/scan', { needle: '100%' });
    assert.equal((await pct.json()).items.length, 1, 'a percent sign is not a wildcard');

    const underscore = await post(svc.base + '/v1/scan', { needle: 'a_b' });
    assert.equal((await underscore.json()).items.length, 1, 'an underscore is not a wildcard');

    const plain = await post(svc.base + '/v1/scan', { needle: '100' });
    assert.equal((await plain.json()).items.length, 2, 'the plain needle still matches both');
  } finally {
    await svc.stop();
  }
});
