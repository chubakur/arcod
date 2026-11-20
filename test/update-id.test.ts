// An id names the row. A patch that carries another id used to move the
// primary key on sql (UPDATE ... SET id = ...) while kv kept the old key and
// stored a record whose id no longer matched it, so "update the id" meant two
// different things per driver. Both facades now answer 400; an echo of the
// same id (a client resending the whole record) stays legal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function specFor(store: 'kv' | 'sql'): string {
  const capability = store === 'kv' ? 'arcod.std.kv' : 'arcod.std.sql';
  const clause = store === 'kv' ? 'uses store: kv' : 'uses db: sql';
  return [
    'module probe @0.1.0 {}',
    '',
    'use capability ' + capability + ' @1',
    'use capability arcod.std.ids @1',
    '',
    'type Item = { id: uuid, name: string }',
    '',
    'error Invalid',
    'error NotFound',
    '',
    'service Probe : http {',
    '  ' + clause,
    '  uses uuid: ids',
    '',
    '  effects {',
    '    allow store.insert, store.update, store.find, uuid.new',
    '  }',
    '',
    '  contract {',
    '    public op create(name: string) -> Item {',
    '      route: "POST /v1/items"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op rename(id: uuid, name: string) -> Item {',
    '      route: "POST /v1/items/rename"',
    '      effects: store.update',
    '      errors: Invalid, NotFound',
    '    }',
    '    public op echo(id: uuid, name: string) -> Item {',
    '      route: "POST /v1/items/echo"',
    '      effects: store.update',
    '      errors: Invalid, NotFound',
    '    }',
    '    public op steal(id: uuid, next: uuid) -> Item {',
    '      route: "POST /v1/items/steal"',
    '      effects: store.update',
    '      errors: Invalid, NotFound',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

const impl = {
  create: [
    'export async function create(input, io) {',
    "  return { result: await io.insert('Item', { id: io.new(), name: input.name }) };",
    '}',
  ].join('\n'),
  rename: [
    'export async function rename(input, io) {',
    "  return { result: await io.update('Item', String(input.id), { name: input.name }) };",
    '}',
  ].join('\n'),
  echo: [
    'export async function echo(input, io) {',
    "  return { result: await io.update('Item', String(input.id), { id: String(input.id), name: input.name }) };",
    '}',
  ].join('\n'),
  steal: [
    'export async function steal(input, io) {',
    "  return { result: await io.update('Item', String(input.id), { id: String(input.next), name: 'moved' }) };",
    '}',
  ].join('\n'),
};

async function call(base: string, op: string, body: unknown) {
  const res = await fetch(base + '/v1/items' + (op === 'create' ? '' : '/' + op), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

for (const store of ['kv', 'sql'] as const) {
  test(store + ': an update cannot move the id to another key', async () => {
    const svc = await startService(specFor(store), { impl });
    try {
      const created = await call(svc.base, 'create', { name: 'first' });
      assert.equal(created.status, 201, created.text);
      const row = JSON.parse(created.text);
      const res = await call(svc.base, 'steal', { id: row.id, next: '00000000-0000-4000-8000-000000000000' });
      assert.equal(res.status, 400, res.text);
      assert.match(res.text, /update Item: id cannot be changed/);
      const renamed = await call(svc.base, 'rename', { id: row.id, name: 'second' });
      assert.equal(renamed.status, 201, renamed.text);
      assert.equal(JSON.parse(renamed.text).id, row.id, 'the row keeps its key');
    } finally {
      await svc.stop();
    }
  });

  test(store + ': a patch echoing the same id is still legal', async () => {
    const svc = await startService(specFor(store), { impl });
    try {
      const created = await call(svc.base, 'create', { name: 'first' });
      const row = JSON.parse(created.text);
      const res = await call(svc.base, 'echo', { id: row.id, name: 'second' });
      assert.equal(res.status, 201, res.text);
      const echoed = JSON.parse(res.text);
      assert.equal(echoed.id, row.id);
      assert.equal(echoed.name, 'second');
    } finally {
      await svc.stop();
    }
  });
}
