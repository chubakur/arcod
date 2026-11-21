import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startService } from './harness.ts';

// The sql driver's in-memory store must serve typed entities (insert/find/
// update/remove + unique -> Conflict) so `arcod test` runs sql examples
// without a live MySQL. This exercises that path end to end.

const specUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);

test('the sql memory driver serves typed entities end to end', async () => {
  const source = await readFile(specUrl, 'utf8');
  const impl: Record<string, string> = {};
  for (const op of ['create', 'list', 'move']) {
    impl[op] = await readFile(new URL('../examples/tasks-sql/impl/' + op + '.mjs', import.meta.url), 'utf8');
  }
  const svc = await startService(source, { impl });
  try {
    const created = await fetch(svc.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', priority: 1 }),
    });
    assert.equal(created.status, 201, 'create returns 201');
    const task = await created.json();
    assert.ok(task.id, 'the created task carries an id');

    const dup = await fetch(svc.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', priority: 2 }),
    });
    assert.equal(dup.status, 409, 'a duplicate title is Conflict');

    const listed = await fetch(svc.base + '/v1/tasks');
    assert.equal(listed.status, 200, 'list returns 200');
    const page = await listed.json();
    assert.ok(Array.isArray(page.items), 'list returns items');
    assert.equal(page.items.length, 1, 'exactly one task');
    assert.equal(page.items[0].title, 'first');

    const moved = await fetch(svc.base + '/v1/tasks/' + task.id + '/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(moved.status, 201, 'move returns 201');
    const movedTask = await moved.json();
    assert.equal(movedTask.status, 'done');
  } finally {
    await svc.stop();
  }
});

test('the emitted mysql store finds pages without shadowing the quoter', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  // entityFind leans on the cursor/order helpers that the service prepends to
  // the store body; mirror just those three so the store can run standalone.
  const preamble = [
    'function parseOrder(order) {',
    "  const list = Array.isArray(order) ? order : String(order || 'id').split(',');",
    '  return list.map((entry) => {',
    '    const parts = String(entry).trim().split(/\\s+/);',
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
    '',
  ].join('\n');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mysql-find-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, preamble + SQL_STORE_SOURCE + '\nexport { SqlStore };\n', 'utf8');
  const { SqlStore } = await import(pathToFileURL(file).href);
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [['a', 'alpha'], ['b', 'beta'], ['c', 'gamma']], affected: 0 };
  };
  const columns = [{ name: 'id', base: 'string' }, { name: 'title', base: 'string' }];
  const page = await store.entityFind('task', columns, { limit: 2, order: 'title asc' });
  assert.equal(page.items.length, 2, 'the page is capped at the limit');
  assert.equal(page.items[0].title, 'alpha', 'rows are decoded into records');
  assert.ok(page.next, 'more rows produce a cursor');
  assert.match(statements[0], /SELECT `id`, `title` FROM `task`/, 'identifiers stay quoted');
  // The null rank comes first: a nullable field sorts NULL last on ASC on
  // every store, and the cursor names the same rank.
  assert.match(statements[0], /ORDER BY \(`title` IS NULL\) ASC, `title` ASC, `id` ASC/, 'the order fields stay quoted');
});

test('the emitted mysql store writes json and list values as utf8mb4 text', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mysql-json-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, SQL_STORE_SOURCE + '\nexport { SqlStore };\n', 'utf8');
  const { SqlStore } = await import(pathToFileURL(file).href);
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 1 };
  };
  const columns = [
    { name: 'id', base: 'string' },
    { name: 'skills', base: 'list' },
    { name: 'meta', base: 'json' },
    { name: 'payload', base: 'bytes' },
  ];
  await store.entityInsert('person', columns, {
    id: 'p1',
    skills: ['plumbing'],
    meta: { ok: true },
    payload: 'raw',
  });
  const sql = statements[0];
  // mysql 3144: JSON cannot be built from a binary string. The literal carries
  // a utf8mb4 introducer, so the bytes are still exact but arrive as text.
  assert.ok(
    sql.includes('_utf8mb4 0x' + Buffer.from('["plumbing"]', 'utf8').toString('hex')),
    'a list value is introduced as utf8mb4: ' + sql
  );
  assert.ok(
    sql.includes('_utf8mb4 0x' + Buffer.from('{"ok":true}', 'utf8').toString('hex')),
    'a json value is introduced as utf8mb4'
  );
  assert.equal((sql.match(/_utf8mb4 0x/g) || []).length, 2, 'only json-shaped values change');
  assert.ok(sql.includes("UNHEX('7031')"), 'a string key stays a binary literal');
  assert.ok(sql.includes("UNHEX('" + Buffer.from('raw', 'utf8').toString('hex') + "')"), 'bytes stay binary');
});
