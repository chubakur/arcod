import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { migrationPlan } from '../src/migrate.ts';
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
