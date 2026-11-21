// A declared container field has a shape: `skills: list<string>` is a list, a
// map is a map, a named record is an object. The stores used to take whatever
// the body handed them -- kv kept a bare string where the type promised a list,
// and the sql JSON column held the JSON text of a string -- so the row broke its
// own declaration and a client reading it crashed on the element it expected.
// The record check now answers Invalid on the shape, and only on the shape: the
// element type belongs to the contract layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module shape @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type Meta = { note: string }',
    'type Row = {',
    '  id: uuid,',
    '  name: string,',
    '  skills: list<string>,',
    '  tags: map<string, string>,',
    '  meta: Meta,',
    '}',
    'error Invalid',
    'error NotFound',
    'service Shape : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.update, store.find, uuid.new }',
    '  contract {',
    '    public op put(skills: json, tags: json, meta: json) -> Row {',
    '      route: "POST /v1/rows"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op patch(id: uuid, skills: json) -> Row {',
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

// The three fields go through op inputs declared as json so the contract layer
// passes them verbatim: what is under test is the record check, not the op one.
const impl = {
  put: [
    'export async function put(input, io) {',
    "  const row = { id: io.new(), name: 'r', skills: input.skills, tags: input.tags, meta: input.meta };",
    "  return { result: await io.insert('Row', row) };",
    '}',
    '',
  ].join('\n'),
  patch: [
    'export async function patch(input, io) {',
    "  return { result: await io.update('Row', input.id, { skills: input.skills }) };",
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patch = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const good = { skills: ['plumbing'], tags: { team: 'ops' }, meta: { note: 'x' } };

const stores: Array<'kv' | 'sql'> = ['kv', 'sql'];

for (const store of stores) {
  test(store + ': a container field refuses the wrong shape on insert and update', async () => {
    const svc = await startService(sourceOf(store), { impl });
    try {
      const created = await post(svc.base, '/v1/rows', good);
      assert.equal(created.status, 201, 'the declared shapes are accepted');
      const row = await created.json();
      assert.deepEqual(row.skills, ['plumbing'], 'a list reads back as a list');

      const skills = await post(svc.base, '/v1/rows', Object.assign({}, good, { skills: 'plumbing' }));
      assert.equal(skills.status, 400, 'a string is not a list');
      assert.match(String((await skills.json()).message), /insert Row: skills must be a list/);

      const tags = await post(svc.base, '/v1/rows', Object.assign({}, good, { tags: ['a', 'b'] }));
      assert.equal(tags.status, 400, 'a list is not a map');
      assert.match(String((await tags.json()).message), /insert Row: tags must be a map/);

      const meta = await post(svc.base, '/v1/rows', Object.assign({}, good, { meta: 'flat' }));
      assert.equal(meta.status, 400, 'a string is not a record');
      assert.match(String((await meta.json()).message), /insert Row: meta must be an object/);

      const blank = await patch(svc.base, '/v1/rows/' + row.id, { skills: 'plumbing' });
      assert.equal(blank.status, 400, 'an update cannot put a string in a list');
      assert.match(String((await blank.json()).message), /update Row: skills must be a list/);

      const kept = await patch(svc.base, '/v1/rows/' + row.id, { skills: ['plumbing', 'heating'] });
      assert.equal(kept.status, 201, 'a valid update still lands');
      assert.deepEqual((await kept.json()).skills, ['plumbing', 'heating']);
    } finally {
      await svc.stop();
    }
  });
}
