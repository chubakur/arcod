import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { migrationPlan } from '../src/migrate.ts';
import { POSTGRES } from '../src/dialects.ts';
import { startService } from './harness.ts';

// A unique rule on a nullable field: the field is not required, so two rows
// may both leave it absent. SQL says a unique index never compares NULLs to
// each other, and the kv claims skip a group that has an absent value. One
// rule on both stores: NULL is not a value anyone holds, so it never clashes.
// This test is the nail: change either side and it turns red.

function specOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv(ttl: 1h)' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module handles @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type Handle = {',
    '  id: uuid,',
    '  name: string,',
    '  alias: string?',
    '}',
    'error NotFound',
    'error Conflict',
    'service Handles : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects { allow store.insert, store.update, store.find, uuid.new }',
    '  rules {',
    '    unique Handle.alias',
    '  }',
    '  contract {',
    '    public op create(name: string, alias: string?) -> Handle {',
    '      route: "POST /v1/handles"',
    '      effects: store.insert, uuid.new',
    '      errors: Conflict',
    '      on error Conflict: name != null',
    '    }',
    '    public op rename(id: uuid, name: string, alias: string?) -> Handle {',
    '      route: "PATCH /v1/handles/:id"',
    '      effects: store.update',
    '      errors: NotFound, Conflict',
    '      on error NotFound: name != null',
    '      on error Conflict: name != null',
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

const IMPL = {
  create: [
    'export async function create(input, io) {',
    "  const row = await io.insert('Handle', { id: io.new(), name: String(input.name), alias: input.alias == null ? null : String(input.alias) });",
    '  return { result: row };',
    '}',
    '',
  ].join('\n'),
  rename: [
    'export async function rename(input, io) {',
    "  const row = await io.update('Handle', input.id, { name: String(input.name), alias: input.alias == null ? null : String(input.alias) });",
    '  return { result: row };',
    '}',
    '',
  ].join('\n'),
};

async function drive(store: 'kv' | 'sql') {
  const svc = await startService(specOf(store), { impl: IMPL });
  try {
    const post = async (name: string, alias: string | null) => {
      const res = await fetch(svc.base + '/v1/handles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, alias }),
      });
      return { status: res.status, body: await res.json() };
    };
    const patch = async (id: string, name: string, alias: string | null) => {
      const res = await fetch(svc.base + '/v1/handles/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, alias }),
      });
      return { status: res.status, body: await res.json() };
    };
    const firstDefault = await post('west', null);
    assert.equal(firstDefault.status, 201, store + ': a row without an alias is fine');
    const secondDefault = await post('east', null);
    assert.equal(secondDefault.status, 201, store + ': a second absent alias does not clash');
    const held = await post('north', 'shared');
    assert.equal(held.status, 201, store + ': the first claim of an alias is fine');
    const clash = await post('south', 'shared');
    assert.equal(clash.status, 409, store + ': the same alias is Conflict');
    const steal = await patch(secondDefault.body.id, 'east', 'shared');
    assert.equal(steal.status, 409, store + ': an update cannot take a held alias');
    const free = await patch(held.body.id, 'north', null);
    assert.equal(free.status, 201, store + ': a row may give its alias up');
    const taken = await post('south', 'shared');
    assert.equal(taken.status, 201, store + ': the alias is free after the update');
    const twoAbsent = await patch(firstDefault.body.id, 'west', null);
    assert.equal(twoAbsent.status, 201, store + ': setting an alias back to absent is fine');
  } finally {
    await svc.stop();
  }
}

test('a nullable unique field never clashes on kv', async () => {
  await drive('kv');
});

test('a nullable unique field never clashes on the sql store', async () => {
  await drive('sql');
});

test('the unique index on a nullable field reaches both dialects unchanged', () => {
  const mod = parse(specOf('sql'), 'main.arc');
  assert.deepEqual(check(mod).filter((item) => item.severity === 'error'), [], 'the spec is valid');
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc);
  const mysql = migrationPlan(mod, svc).migrations.find((item) => item.name === 'handle');
  assert.ok(mysql);
  assert.match(mysql.up, /UNIQUE KEY .uq_handle_alias. /);
  assert.match(mysql.up, /`alias` VARCHAR\(191\)(,|\n)/, 'the column stays nullable');
  const pg = migrationPlan(mod, svc, { dialect: POSTGRES }).migrations.find((item) => item.name === 'handle');
  assert.ok(pg);
  assert.match(pg.up, /CONSTRAINT .uq_handle_alias. UNIQUE \("alias"\)/);
  assert.match(pg.up, /"alias" (TEXT|VARCHAR\(191\))/, 'the column stays nullable');
});
