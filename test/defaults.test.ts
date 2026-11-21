import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { migrationPlan } from '../src/migrate.ts';
import { POSTGRES } from '../src/dialects.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { startService } from './harness.ts';

// A schema default is one fact with several consumers: the DDL writes it as
// DEFAULT, the runtime insert fills it in, and the OpenAPI schema publishes it.
// These tests keep the three in step, on both storage drivers.

const sqlUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);
const kvUrl = new URL('../examples/tasks/main.arc', import.meta.url);

async function load(url: URL): Promise<{ source: string; impl: Record<string, string> }> {
  const source = await readFile(url, 'utf8');
  const impl: Record<string, string> = {};
  for (const op of ['create', 'list', 'move']) {
    try {
      impl[op] = await readFile(new URL('impl/' + op + '.mjs', url), 'utf8');
    } catch {
      // not every example implements every operation
    }
  }
  return { source, impl };
}

function specOf(mod: ReturnType<typeof parse>) {
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return svc;
}

test('the DDL writes a declared default as DEFAULT', async () => {
  const { source } = await load(sqlUrl);
  const mod = parse(source, 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const task = plan.migrations.find((m) => m.name === 'task');
  assert.ok(task, 'the task table is migrated');
  assert.ok(task.up.includes('`done` TINYINT(1) NOT NULL DEFAULT 0'), 'a bool default becomes DEFAULT 0');
  assert.ok(!task.up.includes('`done` TINYINT(1) NOT NULL,'), 'the default is part of the column, not a separate line');
});

test('DDL defaults quote strings and format numbers per column type', () => {
  const spec = [
    'module defaults @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Setting = {',
    '  id: uuid,',
    '  kind: string = "o\'clock",',
    '  active: bool = true,',
    '  retries: int = 3,',
    '  note: string?',
    '}',
    'service Settings : http {',
    '  uses store: sql(ttl: 1h)',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(id: uuid) -> Setting { route: "POST /v1/s" effects: store.insert }',
    '  }',
    '}',
    'environment dev { bind store -> mysql() }',
  ].join('\n');
  const mod = parse(spec, 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const table = plan.migrations.find((m) => m.name === 'setting');
  assert.ok(table, 'the setting table is migrated');
  assert.ok(table.up.includes("DEFAULT 'o''clock'"), 'a quote is escaped by doubling');
  assert.ok(table.up.includes('DEFAULT 1'), 'true becomes 1');
  assert.ok(table.up.includes('DEFAULT 3'), 'a number is written as is');
  assert.ok(table.up.includes('`note` TEXT'), 'an optional field stays nullable');
});

// MySQL answers error 1067 for `DEFAULT '2026-01-01T00:00:00Z'`: a DATETIME
// literal has no zone. Writing the UTC spelling keeps the instant; stripping
// the zone would silently move a +02:00 value by two hours. Postgres keeps the
// instant and casts it.
test('a datetime default is written in the dialect it is applied to', () => {
  const spec = [
    'module stamps @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Stamp = {',
    '  id: uuid,',
    '  at: datetime = "2026-01-01T00:00:00Z",',
    '  local: datetime = "2026-01-01T02:00:00+02:00"',
    '}',
    'service Stamps : http {',
    '  uses store: sql(ttl: 1h)',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(id: uuid) -> Stamp { route: "POST /v1/s" effects: store.insert }',
    '  }',
    '}',
    'environment dev { bind store -> mysql() }',
  ].join('\n');
  const mod = parse(spec, 'main.arc');
  const mysql = migrationPlan(mod, specOf(mod)).migrations.find((m) => m.name === 'stamp');
  assert.ok(mysql, 'the stamp table is migrated');
  assert.ok(mysql!.up.includes("\`at\` DATETIME(3) NOT NULL DEFAULT '2026-01-01 00:00:00'"), mysql!.up);
  assert.ok(mysql!.up.includes("\`local\` DATETIME(3) NOT NULL DEFAULT '2026-01-01 00:00:00'"), 'the offset is converted, not dropped');

  const pg = migrationPlan(mod, specOf(mod), { dialect: POSTGRES }).migrations.find((m) => m.name === 'stamp');
  assert.ok(pg!.up.includes("\"at\" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01T00:00:00Z'::timestamptz"), pg!.up);
});

test('A059 refuses a datetime default that is not a zoned instant', () => {
  const spec = [
    'module stamps @0.1.0 {}',
    'type Stamp = {',
    '  id: uuid,',
    '  naive: datetime = "2026-01-01T00:00:00",',
    '  rollover: datetime = "2026-02-30T00:00:00Z",',
    '  micro: datetime = "2026-01-01T00:00:00.123456Z",',
    '  junk: datetime = "tomorrow"',
    '}',
  ].join('\n');
  const diags = check(parse(spec, 'main.arc'));
  const a059 = diags.filter((item) => item.code === 'A059');
  assert.deepEqual(a059.map((item) => item.path).sort(), ['types.Stamp.junk', 'types.Stamp.micro', 'types.Stamp.naive', 'types.Stamp.rollover']);
  assert.match(a059.find((item) => item.path === 'types.Stamp.micro')!.message, /finer than a millisecond/);
  for (const item of a059.filter((item) => item.path !== 'types.Stamp.micro')) assert.match(item.message, /ISO-8601 instant with a time zone/);
});

// CHAR(36) takes any string and BIGINT silently truncates, so these two
// defaults would pass every layer and only surprise the client or the DBA.
test('A059 keeps a default inside its scalar type', () => {
  const spec = [
    'module kinds @0.1.0 {}',
    'type Row = {',
    '  id: uuid,',
    '  half: int = 1.5,',
    '  typo: uuid = "nope",',
    '  whole: int = 2,',
    '  real: uuid = "550E8400-E29B-41D4-A716-446655440000"',
    '}',
  ].join('\n');
  const diags = check(parse(spec, 'main.arc'));
  const a059 = diags.filter((item) => item.code === 'A059');
  assert.deepEqual(a059.map((item) => item.path).sort(), ['types.Row.half', 'types.Row.typo']);
  assert.match(a059.find((item) => item.path === 'types.Row.half')!.message, /not a whole number/);
  assert.match(a059.find((item) => item.path === 'types.Row.typo')!.message, /not a UUID/);
});

test('OpenAPI publishes the declared default and keeps the field optional', async () => {
  const { source } = await load(sqlUrl);
  const mod = parse(source, 'main.arc');
  const doc = emitOpenapi(mod);
  const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
  const task = schemas.Task as {
    properties: Record<string, { default?: unknown }>;
    required?: string[];
  };
  assert.ok(task, 'Task is a component');
  assert.equal(task.properties.done.default, false, 'the client sees done = false');
  assert.ok(!(task.required ?? []).includes('done'), 'a defaulted field is not required');
});

test('both store drivers fill a default on insert', async () => {
  for (const url of [sqlUrl, kvUrl]) {
    const { source, impl } = await load(url);
    const svc = await startService(source, { impl });
    try {
      const created = await fetch(svc.base + '/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'defaults', priority: 1 }),
      });
      assert.equal(created.status, 201, 'create returns 201 for ' + url.pathname);
      const task = await created.json();
      assert.equal(task.done, false, 'the store filled done = false for ' + url.pathname);
      assert.equal(task.title, 'defaults');
    } finally {
      await svc.stop();
    }
  }
});

test('A059 rejects a default that is not a literal of the field type', async () => {
  const { source } = await load(sqlUrl);
  const bad = parse(source.replace('done: bool = false', 'done: bool = 1'), 'main.arc');
  const diags = check(bad);
  const found = diags.find((item) => item.code === 'A059');
  assert.ok(found, 'a numeric default on a bool field is an error');
  assert.equal(found!.severity, 'error');
  assert.match(found!.message, /true\/false/);

  const expr = parse(source.replace('done: bool = false', 'done: bool = 1 == 1'), 'main.arc');
  assert.match(check(expr).find((item) => item.code === 'A059')!.message, /literal/);

  const good = check(parse(source, 'main.arc'));
  assert.ok(!good.some((item) => item.code === 'A059'), 'the example itself is clean');
});

// A default is filled in by the store, and the store keeps one spelling. The
// declared offset must be converted there too, or a row without the field
// would read back differently on kv (as written) and sql (as UTC).
test('a datetime default is inserted in the canonical spelling', async () => {
  const spec = [
    'module stamps @0.1.0 {}',
    'use capability arcod.std.kv @1',
    'use capability arcod.std.ids @1',
    '',
    'type Stamp = { id: uuid, at: datetime = "2026-01-01T02:00:00+02:00" }',
    '',
    'error Invalid',
    '',
    'service Stamps : http {',
    '  uses store: kv',
    '  uses uuid: ids',
    '',
    '  effects {',
    '    allow store.insert, uuid.new',
    '  }',
    '',
    '  contract {',
    '    public op create() -> Stamp {',
    '      route: "POST /v1/stamps"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
  const impl = {
    create: 'export async function create(input, io) { return { result: await io.insert("Stamp", { id: io.new() }) }; }',
  };
  const svc = await startService(spec, { impl });
  try {
    const res = await fetch(svc.base + '/v1/stamps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).at, '2026-01-01T00:00:00Z');
  } finally {
    await svc.stop();
  }
});

