import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { BuildError, buildExample, resolveDialect } from '../src/build.ts';

// A spec that binds a database of one dialect must be built for that dialect:
// the emitted store, the migrations and the compose provider follow the bind.
const spec = (bind: string) => `
module ledger @0.1.0 {}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type Entry = { id: uuid, amount: int }

service Ledger : http {
  uses store: sql
  uses uuid: ids

  effects {
    allow store.insert, store.find, uuid.new
  }

  contract {
    public op create(amount: int) -> Entry {
      route: "POST /v1/entries"
      effects: store.insert, uuid.new
    }

    public op read() -> Entry {
      route: "GET /v1/entries"
      effects: store.find
    }
  }
}

environment dev {
${bind}
  bind uuid -> local
  deploy docker
}
`;

const postgres = spec('  bind store -> postgres(host: "db", port: 5432)');
const mysql = spec('  bind store -> mysql');

test('the dialect follows the bound database', () => {
  assert.equal(resolveDialect(parse(postgres, 'main.arc')), 'postgres');
  assert.equal(resolveDialect(parse(mysql, 'main.arc')), 'mysql');
  assert.equal(resolveDialect(parse(mysql, 'main.arc'), 'mysql'), 'mysql');
});

test('a spec with no sql bind keeps mysql and still honours an explicit choice', () => {
  const none = spec('  bind uuid -> local');
  assert.equal(resolveDialect(parse(none, 'main.arc')), 'mysql');
  assert.equal(resolveDialect(parse(none, 'main.arc'), 'postgres'), 'postgres');
});

test('an explicit dialect that disagrees with the bind is refused with the bind named', () => {
  assert.throws(
    () => resolveDialect(parse(postgres, 'main.arc'), 'mysql'),
    (error: unknown) => error instanceof BuildError && /bind store -> postgres/.test(error.message) && /mysql/.test(error.message),
  );
});

test('a postgres bind emits the postgres store, migrations and provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dialect-'));
  try {
    await writeFile(join(root, 'main.arc'), postgres);
    const result = await buildExample(parse(postgres, 'main.arc'), root, { port: 8080, reference: true });
    assert.equal(result.dialect, 'postgres');
    const code = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    assert.match(code, /new PgStore\(/);
    assert.doesNotMatch(code, /new SqlStore\(/);
    const compose = await readFile(join(result.dir, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /postgres:16-alpine/);
    assert.doesNotMatch(compose, /mysql:8\.4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same spec with --dialect mysql fails the build instead of shipping a mismatched client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dialect-'));
  try {
    await writeFile(join(root, 'main.arc'), postgres);
    await assert.rejects(
      buildExample(parse(postgres, 'main.arc'), root, { port: 8080, reference: true, dialect: 'mysql' }),
      (error: unknown) => error instanceof BuildError && /bind store -> postgres/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
