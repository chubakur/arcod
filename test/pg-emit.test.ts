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
  assert.match(code, /new PgStore\(process\.env\.DATABASE_URL/);
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
  assert.match(code, /new SqlStore\(process\.env\.DATABASE_URL/);
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
