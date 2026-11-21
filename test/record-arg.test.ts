// A record handed to io.insert/io.update is an object. A body that passed a
// string or null used to fail later and worse: kv's Object.assign spread the
// characters of "nope" into numbered fields, and a null died on .id as a 500.
// The record check names the argument instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module recordarg @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type Row = { id: uuid, name: string }',
    'error Invalid',
    'error NotFound',
    'service RecordArg : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.update, store.find, uuid.new }',
    '  contract {',
    '    public op put() -> Row {',
    '      route: "POST /v1/rows"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op named(id: uuid) -> Row {',
    '      route: "POST /v1/named"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op junk(id: uuid) -> Row {',
    '      route: "PATCH /v1/rows/:id"',
    '      effects: store.update',
    '      errors: Invalid, NotFound',
    '      on error NotFound: id != null',
    '    }',
    '  }',
    '}',
    'environment dev {',
    '  bind store -> ' + bind,
    '  bind uuid -> local',
    '}',
    '',
  ].join('\n');
}

const impl = {
  // The three bodies hand the store something that is not a record at all.
  put: [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Row', null) };",
    '}',
    '',
  ].join('\n'),
  named: [
    'export async function named(input, io) {',
    "  return { result: await io.insert('Row', 'nope') };",
    '}',
    '',
  ].join('\n'),
  junk: [
    'export async function junk(input, io) {',
    "  return { result: await io.update('Row', input.id, 'nope') };",
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, path: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

const patch = (base: string, path: string) =>
  fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });

const stores: Array<'kv' | 'sql'> = ['kv', 'sql'];

for (const store of stores) {
  test(store + ': insert and update refuse a record that is not an object', async () => {
    const svc = await startService(sourceOf(store), { impl });
    try {
      const missing = await post(svc.base, '/v1/rows');
      assert.equal(missing.status, 400, 'a null record is Invalid, not a 500');
      assert.match(String((await missing.json()).message), /insert Row: the record must be an object/);

      const text = await post(svc.base, '/v1/named');
      assert.equal(text.status, 400, 'a string is not a record');
      assert.match(String((await text.json()).message), /insert Row: the record must be an object/);

      const junk = await patch(svc.base, '/v1/rows/' + '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
      assert.equal(junk.status, 400, 'an update patch must be an object too');
      assert.match(String((await junk.json()).message), /update Row: the record must be an object/);
    } finally {
      await svc.stop();
    }
  });
}
