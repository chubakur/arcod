import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from './harness.ts';

// `io.remove` answers whether a row was deleted. The kv driver always did
// that; the sql stores threw the affected count away and the emitted wrapper
// returned true unconditionally, so a DELETE of an id that never existed
// reported success on sql and false on kv. Both drivers and the wrapper now
// agree.

const SPEC = [
  'module remove_count @0.1.0 {}',
  'use capability arcod.std.sql @1',
  'use capability arcod.std.ids @1',
  'type Item = {',
  '  id: uuid,',
  '  name: string',
  '}',
  'error Invalid',
  'service Items : http {',
  '  uses store: sql(ttl: 604800s)',
  '  uses uuid: ids',
  '  effects { allow store.insert, store.remove }',
  '  contract {',
  '    public op add(name: string) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '      on error Invalid: name != null',
  '    }',
  '    public op drop(id: uuid) -> bool {',
  '      route: "DELETE /v1/items/:id"',
  '      effects: store.remove',
  '      errors: Invalid',
  '      on error Invalid: id != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> mysql',
  '  bind uuid -> local',
  '}',
  '',
].join('\n');

const IMPL = {
  add: [
    'export async function add(input, io) {',
    "  const row = await io.insert('Item', { id: io.new(), name: String(input.name) });",
    '  return { result: row };',
    '}',
    '',
  ].join('\n'),
  drop: [
    'export async function drop(input, io) {',
    "  return { result: await io.remove('Item', input.id) };",
    '}',
    '',
  ].join('\n'),
};

test('io.remove reports false for an id that is not there, true once', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const created = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'first' }),
    });
    assert.equal(created.status, 201, 'the item is created');
    const item = await created.json();
    assert.ok(item.id, 'the item carries an id');

    const missing = await fetch(svc.base + '/v1/items/' + '00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    });
    assert.equal(missing.status, 201);
    assert.equal(await missing.json(), false, 'nothing was deleted, so remove is false');

    const removed = await fetch(svc.base + '/v1/items/' + item.id, { method: 'DELETE' });
    assert.equal(removed.status, 201);
    assert.equal(await removed.json(), true, 'the stored row was deleted');

    const again = await fetch(svc.base + '/v1/items/' + item.id, { method: 'DELETE' });
    assert.equal(await again.json(), false, 'a second delete deletes nothing');
  } finally {
    await svc.stop();
  }
});

test('the emitted mysql store returns the affected count from a delete', async () => {
  const { SQL_STORE_SOURCE } = await import('../src/emit/sql-store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mysql-remove-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, SQL_STORE_SOURCE + '\nexport { SqlStore };\n', 'utf8');
  const { SqlStore } = await import(pathToFileURL(file).href);
  const store = new SqlStore('mysql://localhost:3306/arcod');
  const statements: string[] = [];
  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 1 };
  };
  const columns = [{ name: 'id', base: 'string' }, { name: 'name', base: 'string' }];
  assert.equal(await store.entityRemove('item', columns, 'i1'), 1, 'one deleted row is 1');
  assert.match(statements[0], /DELETE FROM `item` WHERE `id` = UNHEX\('6931'\)/);

  store.query = async (sql: string) => {
    statements.push(sql);
    return { rows: [], affected: 0 };
  };
  assert.equal(await store.entityRemove('item', columns, 'i2'), 0, 'a missing row is 0, not a success');
});
