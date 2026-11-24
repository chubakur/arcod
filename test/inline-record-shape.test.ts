// A record field can be written inline (`meta: { note: string }`) instead of
// naming a type. The store check reads the field's own type, so an inline
// record must be an object exactly like a named one -- the branch that unwraps
// `kind === 'record'` had no test, and a shape map that silently skipped the
// field would let a string into a JSON column that promises an object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module inline @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type Row = {',
    '  id: uuid,',
    '  name: string,',
    '  meta: { note: string },',
    '}',
    'error Invalid',
    'service Inline : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.find, uuid.new }',
    '  contract {',
    '    public op put(meta: json) -> Row {',
    '      route: "POST /v1/rows"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
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
  put: [
    'export async function put(input, io) {',
    "  const row = { id: io.new(), name: 'r', meta: input.meta };",
    "  return { result: await io.insert('Row', row) };",
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, body: unknown) =>
  fetch(base + '/v1/rows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

for (const store of ['kv', 'sql'] as const) {
  test(store + ': an inline record field is an object, not a string', async () => {
    const svc = await startService(sourceOf(store), { impl });
    try {
      const created = await post(svc.base, { meta: { note: 'x' } });
      assert.equal(created.status, 201, 'the declared inline record is accepted');
      assert.deepEqual((await created.json()).meta, { note: 'x' });

      const flat = await post(svc.base, { meta: 'flat' });
      assert.equal(flat.status, 400, 'a string is not an inline record');
      assert.match(String((await flat.json()).message), /insert Row: meta must be an object/);
    } finally {
      await svc.stop();
    }
  });
}
