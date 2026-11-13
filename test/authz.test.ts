import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, as } from './harness.ts';

const SPEC = [
  'module authz @0.1.0 {',
  '}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.identity @1',
  '',
  'type DocId = string',
  '',
  'error Unauthorized',
  'error Forbidden',
  'error NotFound',
  '',
  'service Docs : http {',
  '  uses store: kv',
  '  uses auth: identity',
  '',
  '  effects {',
  '    allow store.set, store.get, auth.actor',
  '  }',
  '',
  '  contract {',
  '    auth op create(id: DocId, title: string) -> DocId {',
  '      route: "POST /v1/docs"',
  '      effects: store.set, auth.actor',
  '      errors: Unauthorized',
  '      post: result != null',
  '      on error Unauthorized: id != null',
  '    }',
  '',
  '    public op read(id: DocId) -> DocId {',
  '      route: "GET /v1/docs/:id"',
  '      effects: store.get',
  '      errors: NotFound',
  '      post: result != null',
  '      on error NotFound: id != null',
  '    }',
  '',
  '    auth op remove(id: DocId) -> DocId {',
  '      route: "DELETE /v1/docs/:id"',
  '      owner: id',
  '      effects: store.get, auth.actor',
  '      errors: Unauthorized, Forbidden, NotFound',
  '      post: result != null',
  '      on error Unauthorized: id != null',
  '      on error Forbidden: id != null',
  '      on error NotFound: id != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "redis", port: 6379)',
  '  bind auth -> keycloak(host: "idp", port: 8080)',
  '}',
].join('\n');

const IMPL = {
  create: [
    'export async function create(input, io) {',
    '  const actor = await io.actor();',
    '  await io.save(String(input.id), { b: { title: String(input.title), owner: actor.id }, h: null });',
    '  return { result: String(input.id) };',
    '}',
  ].join('\n'),
  read: [
    'export async function read(input, io) {',
    '  const rec = await io.load(String(input.id));',
    '  if (!rec) return { error: "NotFound" };',
    '  return { result: String(input.id) };',
    '}',
  ].join('\n'),
  remove: [
    'export async function remove(input, io) {',
    '  // The runtime guard already rejected anonymous (401) and non-owner (403)',
    '  // callers; the body is only reached for the owner (or an admin).',
    '  await io.del(String(input.id));',
    '  return { result: String(input.id) };',
    '}',
  ].join('\n'),
};

test('auth ops reject anonymous callers with 401, owner mismatch with 403', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    // anonymous create -> 401
    const anonCreate = await fetch(svc.base + '/v1/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd1', title: 'hello' }),
    });
    assert.equal(anonCreate.status, 401, 'anonymous create is Unauthorized');

    // authenticated create -> 201
    const created = await fetch(svc.base + '/v1/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('alice') },
      body: JSON.stringify({ id: 'd1', title: 'hello' }),
    });
    assert.equal(created.status, 201, 'authenticated create succeeds');

    // public read by anyone -> 200
    const read = await fetch(svc.base + '/v1/docs/d1');
    assert.equal(read.status, 200, 'public read is allowed');

    // anonymous remove (auth op) -> 401
    const anonRemove = await fetch(svc.base + '/v1/docs/d1', { method: 'DELETE' });
    assert.equal(anonRemove.status, 401, 'anonymous remove is Unauthorized');

    // remove by a non-owner -> 403
    const foreignRemove = await fetch(svc.base + '/v1/docs/d1', {
      method: 'DELETE',
      headers: as('bob'),
    });
    assert.equal(foreignRemove.status, 403, 'non-owner remove is Forbidden');

    // remove by the owner -> 200
    const ownerRemove = await fetch(svc.base + '/v1/docs/d1', {
      method: 'DELETE',
      headers: as('alice'),
    });
    assert.equal(ownerRemove.status, 201, 'owner remove succeeds');

    // the record is really gone: io.del removed it from the store
    const readAfter = await fetch(svc.base + '/v1/docs/d1');
    assert.equal(readAfter.status, 404, 'the record is gone after remove');
  } finally {
    await svc.stop();
  }
});

test('an admin bypasses the owner check', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    await fetch(svc.base + '/v1/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('alice') },
      body: JSON.stringify({ id: 'd1', title: 'hello' }),
    });
    const adminRemove = await fetch(svc.base + '/v1/docs/d1', {
      method: 'DELETE',
      headers: as('bob', true),
    });
    assert.equal(adminRemove.status, 201, 'admin bypasses ownership');
  } finally {
    await svc.stop();
  }
});
