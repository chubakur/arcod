import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { migrationPlan } from '../src/migrate.ts';
import { formatSource } from '../src/fmt.ts';
import { POSTGRES } from '../src/dialects.ts';
import { startService } from './harness.ts';

// A unique rule names one field or a tuple on the same record. Both spellings
// must parse, validate every field, reach the DDL as one composite key, and be
// enforced by the kv claims: two records with the same pair are a Conflict,
// the same fence with another name is not.

const TUPLE_SPEC = [
  'module fences @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  'type Fence = {',
  '  id: uuid,',
  '  name: string,',
  '  fence: string',
  '}',
  'error Invalid',
  'error Conflict',
  'service Fences : http {',
  '  uses store: kv(ttl: 1h)',
  '  uses uuid: ids',
  '  effects { allow store.insert, store.find, uuid.new }',
  '  rules {',
  '    unique Fence.(name, fence)',
  '  }',
  '  contract {',
  '    public op create(name: string, fence: string) -> Fence {',
  '      route: "POST /v1/fences"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid, Conflict',
  '      on error Invalid: name != null',
  '      on error Conflict: name != null',
  '    }',
  '    public op list() -> { items: list<Fence>, next: string? } {',
  '      route: "GET /v1/fences"',
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

function specOf(mod: ReturnType<typeof parse>) {
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return svc;
}

test('a unique tuple parses in both spellings and survives fmt', () => {
  const dotted = TUPLE_SPEC.replace('unique Fence.(name, fence)', 'unique Fence.name, Fence.fence');
  for (const source of [TUPLE_SPEC, dotted]) {
    const mod = parse(source, 'main.arc');
    const rule = specOf(mod).rules.find((item) => item.kind === 'unique');
    assert.ok(rule && rule.kind === 'unique');
    assert.deepEqual(rule.fields, ['name', 'fence']);
    const diags = check(mod).filter((item) => item.severity === 'error');
    assert.deepEqual(diags, [], 'a two-field tuple is valid');
    const once = formatSource(source, 'main.arc');
    assert.match(once, /unique Fence\.\(name, fence\)/);
    assert.equal(formatSource(once, 'main.arc'), once, 'formatting is idempotent');
  }
});

test('a tuple naming a missing field is A054', () => {
  const mod = parse(TUPLE_SPEC.replace('(name, fence)', '(name, wall)'), 'main.arc');
  const codes = check(mod).filter((item) => item.severity === 'error').map((item) => item.code);
  assert.ok(codes.includes('A054'), 'the missing tuple field is rejected');
});

test('a unique tuple becomes one composite key in mysql and postgres', () => {
  const mod = parse(TUPLE_SPEC, 'main.arc');
  const mysql = migrationPlan(mod, specOf(mod)).migrations.find((item) => item.name === 'fence');
  assert.ok(mysql);
  assert.match(mysql.up, /UNIQUE KEY .uq_fence_name_fence. \(.name., .fence.\)/);
  const pg = migrationPlan(mod, specOf(mod), { dialect: POSTGRES }).migrations.find((item) => item.name === 'fence');
  assert.ok(pg);
  assert.match(pg.up, /CONSTRAINT .uq_fence_name_fence. UNIQUE \("name", "fence"\)/);
});


const MUTABLE_SPEC = [
  'module fences2 @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  'type Fence = {',
  '  id: uuid,',
  '  name: string,',
  '  fence: string',
  '}',
  'error Invalid',
  'error NotFound',
  'error Conflict',
  'service Fences2 : http {',
  '  uses store: kv(ttl: 1h)',
  '  uses uuid: ids',
  '  effects { allow store.insert, store.update, store.remove, store.find, uuid.new }',
  '  rules {',
  '    unique Fence.(name, fence)',
  '  }',
  '  contract {',
  '    public op create(name: string, fence: string) -> Fence {',
  '      route: "POST /v1/fences"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid, Conflict',
  '      on error Invalid: name != null',
  '      on error Conflict: name != null',
  '    }',
  '    public op move(id: uuid, name: string, fence: string) -> Fence {',
  '      route: "PATCH /v1/fences/:id"',
  '      effects: store.update',
  '      errors: Invalid, NotFound, Conflict',
  '      on error Invalid: id != null',
  '      on error NotFound: id != null',
  '      on error Conflict: id != null',
  '    }',
  '    public op drop(id: uuid) -> bool {',
  '      route: "DELETE /v1/fences/:id"',
  '      effects: store.remove',
  '      errors: NotFound',
  '      on error NotFound: id != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '}',
  '',
].join('\n');

test('moving a record releases and claims its unique tuple', async () => {
  const impl = {
    create: [
      'export async function create(input, io) {',
      "  const row = await io.insert('Fence', { id: io.new(), name: String(input.name), fence: String(input.fence) });",
      '  return { result: row };',
      '}',
      '',
    ].join('\n'),
    move: [
      'export async function move(input, io) {',
      "  const row = await io.update('Fence', input.id, { name: String(input.name), fence: String(input.fence) });",
      '  return { result: row };',
      '}',
      '',
    ].join('\n'),
    drop: [
      'export async function drop(input, io) {',
      "  return { result: await io.remove('Fence', input.id) };",
      '}',
      '',
    ].join('\n'),
  };
  const svc = await startService(MUTABLE_SPEC, { impl });
  try {
    const post = async (body: unknown) => {
      const res = await fetch(svc.base + '/v1/fences', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const west = await post({ name: 'west', fence: 'f1' });
    const east = await post({ name: 'east', fence: 'f1' });
    assert.equal(west.status, 201);
    assert.equal(east.status, 201);
    const move = (id: string, name: string, fence: string) => fetch(svc.base + '/v1/fences/' + id, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, fence }),
    });
    const clash = await move(east.body.id, 'west', 'f1');
    assert.equal(clash.status, 409, 'taking a taken pair is Conflict');
    const freed = await fetch(svc.base + '/v1/fences/' + west.body.id, { method: 'DELETE' });
    assert.equal(freed.status, 201, 'the record is gone');
    const ok = await move(east.body.id, 'west', 'f1');
    assert.equal(ok.status, 201, 'the released pair can be claimed');
    const created = await post({ name: 'west', fence: 'f1' });
    assert.equal(created.status, 409, 'the moved record holds the pair');
  } finally {
    await svc.stop();
  }
});

test('a duplicate pair is Conflict, another name on the same fence is not', async () => {
  const impl = {
    create: [
      'export async function create(input, io) {',
      "  const name = String(input.name || '').trim();",
      "  const fence = String(input.fence || '').trim();",
      "  if (!name || !fence) return { error: 'Invalid' };",
      "  const row = await io.insert('Fence', { id: io.new(), name, fence });",
      '  return { result: row };',
      '}',
      '',
    ].join('\n'),
    list: [
      'export async function list(input, io) {',
      "  const page = await io.find('Fence', { limit: 50 });",
      '  return { result: page };',
      '}',
      '',
    ].join('\n'),
  };
  const svc = await startService(TUPLE_SPEC, { impl });
  try {
    const post = (body: unknown) => fetch(svc.base + '/v1/fences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const first = await post({ name: 'west', fence: 'f1' });
    assert.equal(first.status, 201);
    const dup = await post({ name: 'west', fence: 'f1' });
    assert.equal(dup.status, 409, 'the same pair is Conflict');
    const other = await post({ name: 'east', fence: 'f1' });
    assert.equal(other.status, 201, 'another name on the same fence is fine');
    const listed = await fetch(svc.base + '/v1/fences');
    assert.equal(listed.status, 200);
    const page = await listed.json();
    assert.equal(page.items.length, 2);
  } finally {
    await svc.stop();
  }
});
