import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { migrationPlan } from '../src/migrate.ts';
import { dialectNamed, POSTGRES, MYSQL } from '../src/dialects.ts';

// A dialect is a spelling of the same model: types, quoting, defaults and
// index syntax differ, the facts do not. MySQL stays the runtime dialect; the
// Postgres plan has to be usable as DDL before an adapter exists.

const signupUrl = new URL('../examples/signup/main.arc', import.meta.url);
const tasksSqlUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);

function specOf(mod: ReturnType<typeof parse>) {
  const svc = mod.services.find((item) => !item.external);
  assert.ok(svc, 'the module has a local service');
  return svc;
}

test('Postgres DDL quotes, types and defaults its own way', async () => {
  const mod = parse(await readFile(signupUrl, 'utf8'), 'main.arc');
  const plan = migrationPlan(mod, specOf(mod), { dialect: POSTGRES });
  const account = plan.migrations.find((m) => m.name === 'account')!;
  assert.match(account.up, /CREATE TABLE IF NOT EXISTS "account" \(/);
  assert.match(account.up, /"email" VARCHAR\(191\) NOT NULL/);
  assert.match(account.up, /"website" TEXT/);
  assert.match(account.up, /"plan" VARCHAR\(64\) NOT NULL DEFAULT 'free'/);
  assert.match(account.up, /"createdAt" TIMESTAMPTZ NOT NULL/);
  assert.match(account.up, /CONSTRAINT "uq_account_email" UNIQUE \("email"\)/);
  assert.doesNotMatch(account.up, /ENGINE=InnoDB/);
  assert.doesNotMatch(account.up, /UNIQUE KEY/);
  assert.equal(account.down, 'DROP TABLE IF EXISTS "account"');
});

test('Postgres spells an index as its own statement', async () => {
  const mod = parse(await readFile(tasksSqlUrl, 'utf8'), 'main.arc');
  const plan = migrationPlan(mod, specOf(mod), { dialect: POSTGRES });
  const task = plan.migrations.find((m) => m.name === 'task')!;
  assert.match(task.up, /CREATE INDEX IF NOT EXISTS "idx_task_dueAt" ON "task" \("dueAt"\);$/m);
  assert.doesNotMatch(task.up, /UNIQUE KEY/);
  assert.doesNotMatch(task.up, /^ {2}KEY /m);
});

test('the default plan stays MySQL, byte for byte', async () => {
  const mod = parse(await readFile(tasksSqlUrl, 'utf8'), 'main.arc');
  const plan = migrationPlan(mod, specOf(mod));
  const task = plan.migrations.find((m) => m.name === 'task')!;
  assert.match(task.up, /ENGINE=InnoDB$/);
  assert.match(task.up, /UNIQUE KEY `uq_task_title` [(]`title`[)]/);
  // The kv table predates the dialect seam; its DDL must not drift, because
  // an applied migration is checksummed.
  const kv = plan.migrations.find((m) => m.name === 'arcod_kv')!;
  assert.equal(
    kv.up,
    'CREATE TABLE IF NOT EXISTS arcod_kv (k VARBINARY(255) NOT NULL PRIMARY KEY, v LONGBLOB NOT NULL, expires_at BIGINT NOT NULL, KEY arcod_kv_expires (expires_at)) ENGINE=InnoDB',
  );
});

test('a dialect is selected by name and unknown ones are rejected', () => {
  assert.equal(dialectNamed(undefined), MYSQL);
  assert.equal(dialectNamed('mysql'), MYSQL);
  assert.equal(dialectNamed('postgres'), POSTGRES);
  assert.equal(dialectNamed('postgresql'), POSTGRES);
  assert.throws(() => dialectNamed('oracle'), /unknown sql dialect oracle/);
});
