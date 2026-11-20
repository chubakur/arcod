// A cursor is built from the same order the query ran with. keysetClause used
// to `continue` past an order field the entity does not declare: the term
// disappeared while `values` stayed aligned to the full order, so the next
// page could repeat or skip rows. entityFind already rejects the field, so the
// guard is unreachable from HTTP; it is now loud instead of silently wrong
// when called directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const preamble = [
  'class ArcodError extends Error {',
  '  constructor(code, data) { super((data && data.message) || code); this.code = code; this.data = data; }',
  '}',
  'function parseOrder(order) {',
  "  const list = Array.isArray(order) ? order : String(order || 'id').split(',');",
  '  return list.map((entry) => {',
  "    const parts = String(entry).trim().split(/\\s+/);",
  "    return { field: parts[0], dir: (parts[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1 };",
  '  });',
  '}',
  "function encodeCursor(values, id) { return Buffer.from(JSON.stringify({ v: values, id })).toString('base64url'); }",
  "function decodeCursor(cursor) { try { return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { return null; } }",
  "function pgLiteral(base, value) { if (value === null || value === undefined) return 'NULL'; return \"'\" + String(value).split(\"'\").join(\"''\") + \"'\"; }",
  "class PgConnection { constructor(url) { this.url = url; } }",
  '',
].join('\n');

async function load(name: 'sql-store' | 'pg-store', source: string, className: string): Promise<{ store: any }> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-keyset-' + name + '-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, preamble + source + '\nexport { ' + className + ' };\n', 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return { store: new mod[className]('x://localhost/db') };
}

const columns = [{ name: 'id', base: 'string' }, { name: 'title', base: 'string' }];

test('the mysql keyset clause compares the ordered column and then id', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { store } = await load('sql-store', SQL_STORE_SOURCE, 'SqlStore');
  const clause = store.keysetClause(columns, [{ field: 'title', dir: 1 }], ['b'], 'b');
  assert.match(clause, /`title` > UNHEX\('62'\)/);
  assert.match(clause, /`id` > UNHEX\('62'\)/);
});

test('the postgres keyset clause keeps IS NOT DISTINCT FROM for ties', async () => {
  const { PG_SQL_STORE_SOURCE } = await import('../src/emit/pg-store.ts');
  const { store } = await load('pg-store', PG_SQL_STORE_SOURCE, 'PgStore');
  const clause = store.keysetClause(columns, [{ field: 'title', dir: -1 }], ['b'], 'b');
  assert.match(clause, /"title" < 'b'/);
  assert.match(clause, /"title" IS NOT DISTINCT FROM 'b'/);
});

test('an unknown order field in a cursor is Invalid, never a dropped term', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { store } = await load('sql-store', SQL_STORE_SOURCE, 'SqlStore');
  assert.throws(
    () => store.keysetClause(columns, [{ field: 'title', dir: 1 }, { field: 'missing', dir: 1 }], ['b', 'x'], 'b'),
    (error: any) => error.code === 'Invalid' && /order: unknown field "missing"/.test(error.message),
  );
});
