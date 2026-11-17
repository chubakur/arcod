import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { migrationPlan } from '../src/migrate.ts';
import { formatSource } from '../src/fmt.ts';

// An index is a model fact, not a deploy-time afterthought: 'index Task.dueAt'
// has to reach the generated DDL, survive formatting and be rejected when the
// field does not exist.

const sqlUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);

function specOf(mod: ReturnType<typeof parse>) {
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return svc;
}

test('a declared index becomes a KEY in the generated DDL', async () => {
  const source = await readFile(sqlUrl, 'utf8');
  const mod = parse(source, 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const task = plan.migrations.find((m) => m.name === 'task');
  assert.ok(task, 'the task table is migrated');
  assert.match(task.up, /KEY .idx_task_dueAt. \(.dueAt.\)/);
});

test('an indexed unique field is not indexed twice', () => {
  const source = [
    'module m @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Task = { id: uuid, title: string }',
    'error Conflict',
    'service S : http {',
    '  uses store: sql(ttl: 1h)',
    '  effects { allow store.insert }',
    '  rules {',
    '    unique Task.title',
    '    index Task.title',
    '  }',
    '  contract {',
    '    public op create(id: uuid, title: string) -> Task { route: "POST /v1/t" }',
    '  }',
    '}',
    'environment dev { bind store -> mysql() }',
  ].join('\n');
  const mod = parse(source, 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const task = plan.migrations.find((m) => m.name === 'task')!;
  assert.match(task.up, /UNIQUE KEY .uq_task_title./);
  assert.doesNotMatch(task.up, /idx_task_title/, 'the unique b-tree already covers the column');
});

test('A062 rejects an index on a field that does not exist', () => {
  const source = [
    'module m @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Task = { id: uuid, title: string }',
    'service S : http {',
    '  uses store: sql(ttl: 1h)',
    '  rules { index Task.missing }',
    '  contract { public op create(id: uuid) -> Task { route: "POST /v1/t" } }',
    '}',
    'environment dev { bind store -> mysql() }',
  ].join('\n');
  const diags = check(parse(source, 'main.arc')).filter((item) => item.code === 'A062');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /does not name a field/);
});

test('fmt keeps the index rule', async () => {
  const source = await readFile(sqlUrl, 'utf8');
  const once = formatSource(source, 'main.arc');
  assert.match(once, /^ {4}index Task\.dueAt$/m);
  assert.equal(formatSource(once, 'main.arc'), once, 'formatting is idempotent');
});
