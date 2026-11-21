// An enum field holds one of its declared members. The op boundary validates an
// input, but a record built inside a body never crosses that boundary: both
// stores used to keep a non-member in a status column as if the enum allowed it,
// so the row contradicted its own declaration and a client that switched on the
// declared members fell through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module enums @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'enum Status { draft, live }',
    'type Item = { id: uuid, status: Status, plan: Status = draft }',
    'error Invalid',
    'error NotFound',
    'service Enums : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.update, store.find, uuid.new }',
    '  contract {',
    '    public op put(status: json) -> Item {',
    '      route: "POST /v1/items"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op patch(id: uuid, status: json) -> Item {',
    '      route: "PATCH /v1/items/:id"',
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

// status goes through an op input declared json so the contract layer passes it
// verbatim: the declared member rule under test is the record one.
const impl = {
  put: [
    'export async function put(input, io) {',
    "  const item = { id: io.new(), status: input.status, plan: 'draft' };",
    "  return { result: await io.insert('Item', item) };",
    '}',
    '',
  ].join('\n'),
  patch: [
    'export async function patch(input, io) {',
    "  return { result: await io.update('Item', input.id, { status: input.status }) };",
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patch = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const stores: Array<'kv' | 'sql'> = ['kv', 'sql'];

for (const store of stores) {
  test(store + ': an enum field keeps its declared members', async () => {
    const svc = await startService(sourceOf(store), { impl });
    try {
      const ok = await post(svc.base, '/v1/items', { status: 'live' });
      assert.equal(ok.status, 201, 'a declared member is stored');
      const item = await ok.json();
      assert.equal(item.status, 'live');
      assert.equal(item.plan, 'draft', 'the declared default still fills the second enum');

      const bad = await post(svc.base, '/v1/items', { status: 'statuz' });
      assert.equal(bad.status, 400, 'a non-member is Invalid, not a stored string');
      assert.match(String((await bad.json()).message), /insert Item: status must be one of draft, live/);

      const cleared = await patch(svc.base, '/v1/items/' + item.id, { status: 'archived' });
      assert.equal(cleared.status, 400, 'an update cannot move the field off its members');
      assert.match(String((await cleared.json()).message), /update Item: status must be one of draft, live/);

      const moved = await patch(svc.base, '/v1/items/' + item.id, { status: 'draft' });
      assert.equal(moved.status, 201, 'a member still updates');
      assert.equal((await moved.json()).status, 'draft');
    } finally {
      await svc.stop();
    }
  });
}
