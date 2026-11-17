import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from '../src/parser.ts';
import { emitService } from '../src/emit/service.ts';

// One sql contract, two wire clients: the build picks the dialect and the
// emitted service must carry exactly one of them, with that dialect's DDL.
const run = promisify(execFile);
const spec = new URL('../examples/tasks-sql/main.arc', import.meta.url);

async function emit(dialect?: 'postgres') {
  const mod = parse(await readFile(spec, 'utf8'), 'main.arc');
  return emitService(mod, dialect ? { dialect } : {});
}

test('a postgres build carries the postgres store and its migrations', async () => {
  const code = await emit('postgres');
  assert.match(code, /class PgStore/);
  assert.match(code, /new PgStore\(assertDialectUrl\(process\.env\.DATABASE_URL/);
  assert.match(code, /assertDialectUrl\(url, expected\)/);
  assert.match(code, /postgres:\/\/arcod/);
  assert.match(code, /ON CONFLICT \(k\) DO NOTHING/);
  assert.match(code, /IS NOT DISTINCT FROM/);
  assert.match(code, /BYTEA/);
  assert.doesNotMatch(code, /class SqlStore/);
  assert.doesNotMatch(code, /MySqlConnection/);
  assert.doesNotMatch(code, /UNHEX\(/);
  assert.doesNotMatch(code, /ENGINE=InnoDB/);
});

test('mysql stays the default spelling and is unchanged', async () => {
  const code = await emit();
  assert.match(code, /class SqlStore/);
  assert.match(code, /new SqlStore\(assertDialectUrl\(process\.env\.DATABASE_URL/);
  assert.match(code, /this build speaks ' \+ expected/);
  assert.match(code, /ENGINE=InnoDB/);
  assert.doesNotMatch(code, /class PgStore/);
  assert.doesNotMatch(code, /BYTEA/);
});

test('both emitted services are syntactically valid modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pg-emit-'));
  for (const [name, code] of [['mysql', await emit()], ['postgres', await emit('postgres')]] as const) {
    const file = join(dir, name + '.mjs');
    await writeFile(file, code, 'utf8');
    await run(process.execPath, ['--check', file]);
  }
});

test('the outbox dispatcher constructs the dialect client, not a hard-coded one', async () => {
  const { outboxSource } = await import('../src/emit/queue.ts');
  const mysql = outboxSource();
  assert.match(mysql, /new SqlStore\(/);
  assert.doesNotMatch(mysql, /new PgStore\(/);
  const postgres = outboxSource('postgres');
  assert.match(postgres, /new PgStore\(process\.env\.DATABASE_URL/);
  assert.match(postgres, /postgres:\/\/arcod/);
  assert.doesNotMatch(postgres, /new SqlStore\(/);
});

test('a sql service with no binding gets the database its build speaks', async () => {
  const { composeYaml } = await import('../src/emit/compose.ts');
  const mod = parse([
    'module bare @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Note = { id: uuid, text: string }',
    'service Notes : http {',
    '  uses store: sql(ttl: 1h)',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(id: uuid) -> Note { route: "POST /v1/n" effects: store.insert }',
    '  }',
    '}',
  ].join('\n'), 'main.arc');
  const mysql = composeYaml(mod, 8080, false);
  assert.match(mysql, /image: mysql:8\.4/);
  assert.match(mysql, /DATABASE_URL: ["']mysql:\/\/arcod:arcod@mysql:3306\/arcod["']/);
  assert.doesNotMatch(mysql, /postgres:16-alpine/);
  const postgres = composeYaml(mod, 8080, false, undefined, 'postgres');
  assert.match(postgres, /postgres:16-alpine/);
  assert.match(postgres, /DATABASE_URL: ["']postgres:\/\/arcod:arcod@postgres:5432\/arcod["']/);
  assert.doesNotMatch(postgres, /mysql:8\.4/);
});

test('a postgres build runs the tasks-sql examples on the memory driver', async () => {
  const { buildExample } = await import('../src/build.ts');
  const { runExamples } = await import('../src/test.ts');
  const { cp, mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const source = await readFile(spec, 'utf8');
  const mod = parse(source, 'main.arc');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pg-run-'));
  await writeFile(join(dir, 'main.arc'), source, 'utf8');
  await cp(new URL('../examples/tasks-sql/impl', import.meta.url), join(dir, 'impl'), { recursive: true });
  const built = await buildExample(mod, dir, { dialect: 'postgres' });
  const report = await runExamples(mod, built.dir);
  assert.deepEqual(report.examples.filter((example) => !example.ok), []);
  assert.ok(report.examples.length >= 2, 'the example file has checks');
});

test('k8s manifests carry the same database choice as the build', async () => {
  const { k8sManifests } = await import('../src/emit/k8s.ts');
  const mod = parse([
    'module barens @0.1.0 {}',
    'use capability arcod.std.sql @1',
    'type Note = { id: uuid, text: string }',
    'service Notes : http {',
    '  uses store: sql(ttl: 1h)',
    '  effects { allow store.insert }',
    '  contract {',
    '    public op create(id: uuid) -> Note { route: "POST /v1/n" effects: store.insert }',
    '  }',
    '}',
  ].join('\n'), 'main.arc');
  const plain = k8sManifests(mod).map((file) => file.content).join('\n');
  assert.match(plain, /image: mysql:8\.4/);
  assert.doesNotMatch(plain, /postgres:16-alpine/);
  const pg = k8sManifests(mod, { dialect: 'postgres' }).map((file) => file.content).join('\n');
  assert.match(pg, /postgres:16-alpine/);
  assert.doesNotMatch(pg, /image: mysql:8\.4/);
});
