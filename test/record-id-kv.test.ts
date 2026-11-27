// The kv facade keys a record by id, so id is not a declared column. Two
// regressions came from treating it as an unknown field: insert with an
// explicit id answered 400, and the default order (id) failed validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module recordid @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  'type Row = { id: uuid, name: string }',
  'error Invalid',
  'service RecordId : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '  effects { allow store.insert, store.find, uuid.new }',
  '  contract {',
  '    public op add(id: uuid) -> Row {',
  '      route: "POST /v1/rows/:id"',
  '      effects: store.insert',
  '      errors: Invalid',
  '    }',
  '    public op list() -> list<Row> {',
  '      route: "GET /v1/rows"',
  '      effects: store.find',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '}',
  '',
].join('\n');

const impl = {
  add: [
    'export async function add(input, io) {',
    "  return { result: await io.insert('Row', { id: input.id, name: 'named' }) };",
    '}',
    '',
  ].join('\n'),
  list: [
    'export async function list(input, io) {',
    "  return { result: (await io.find('Row', { limit: 10 })).items };",
    '}',
    '',
  ].join('\n'),
};

test('kv: id is the record key and the default order', async () => {
  const svc = await startService(source, { impl });
  try {
    const id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    const add = await fetch(svc.base + '/v1/rows/' + id, { method: 'POST' });
    assert.equal(add.status, 201, 'an explicit id is the key, not an unknown field');
    const list = await fetch(svc.base + '/v1/rows');
    assert.equal(list.status, 200, 'the default order is id, which every entity has');
    const rows = await list.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
  } finally {
    await svc.stop();
  }
});
