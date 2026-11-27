// B112 (issue #64): the runtime raises Unauthorized and Forbidden itself, so
// an auth op whose contract does not declare them still owes the caller 401 /
// 403. The error table used to be built only from `errors:` clauses, so the
// anonymous request hit the 500 fallback instead. These tests run real HTTP
// calls: the emitted text could carry the fallback and still be wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, as } from './harness.ts';

const NL = String.fromCharCode(10);

const SPEC = [
  'module authn @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.identity @1',
  '',
  'type DocId = string',
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
  '    auth op write(id: DocId, title: string) -> DocId {',
  '      route: "POST /v1/docs"',
  '      effects: store.set, auth.actor',
  '      post: result != null',
  '    }',
  '',
  '    auth op erase(id: DocId) -> DocId {',
  '      route: "DELETE /v1/docs/:id"',
  '      owner: id',
  '      effects: store.get, auth.actor',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "redis", port: 6379)',
  '  bind auth -> keycloak(host: "idp", port: 8080)',
  '}',
  '',
].join(NL);

const IMPL = {
  write: [
    'export async function write(input, io) {',
    '  const actor = await io.actor();',
    '  await io.set(String(input.id), { title: String(input.title), owner: actor.id });',
    '  return { result: String(input.id) };',
    '}',
  ].join(NL),
  erase: [
    'export async function erase(input, io) {',
    '  await io.del(String(input.id));',
    '  return { result: String(input.id) };',
    '}',
  ].join(NL),
};

test('an auth op without a declared Unauthorized still answers 401', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const response = await fetch(svc.base + '/v1/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd1', title: 'hello' }),
    });
    assert.equal(response.status, 401, 'anonymous write is Unauthorized, not a 500');
    const body = await response.json();
    assert.equal(body.error, 'Unauthorized');
    assert.equal(body.message, 'unauthorized');
  } finally {
    await svc.stop();
  }
});

test('an auth op without a declared Forbidden still answers 403', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const created = await fetch(svc.base + '/v1/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('alice') },
      body: JSON.stringify({ id: 'd1', title: 'hello' }),
    });
    assert.equal(created.status, 201, await created.text());
    const foreign = await fetch(svc.base + '/v1/docs/d1', { method: 'DELETE', headers: as('bob') });
    assert.equal(foreign.status, 403, 'non-owner erase is Forbidden, not a 500');
    const body = await foreign.json();
    assert.equal(body.error, 'Forbidden');
    // The declared table still wins where a contract names the error.
    const owner = await fetch(svc.base + '/v1/docs/d1', { method: 'DELETE', headers: as('alice') });
    assert.equal(owner.status, 201, 'the owner erases it');
  } finally {
    await svc.stop();
  }
});
