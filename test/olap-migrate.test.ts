// B95.5: `arcod migrate` turns the analytical tables into DDL and, when a
// target is named, creates them over the same HTTP 8123 interface the adapter
// uses. The tests keep three promises: the schema file is written offline, a
// server is only touched when asked, and one failing table names itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockHttp } from './harness.ts';
import { parse } from '../src/parser.ts';
import { olapTablesFromTypes, olapUseOptions } from '../src/emit/olap.ts';
import { applyClickhouseSchema, olapTarget } from '../src/olap-apply.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int, at: datetime, note: string? }',
  'type DayRow = { day: string, bytes: int }',
  '',
  'service Analytics : http {',
  '  uses events: olap(orderBy: "day")',
  '',
  '  effects {',
  '    allow events.append',
  '  }',
  '',
  '  contract {',
  '    public op record(id: string, day: string, bytes: int) -> { ok: bool } {',
  '      route: "POST /v1/record"',
  '      effects: events.append',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind events -> clickhouse',
  '  deploy docker',
  '}',
  '',
].join('\n');

function tables() {
  const mod = parse(SPEC, 'main.arc');
  const use = mod.services.flatMap((svc) => svc.uses).find((candidate) => candidate.capability === 'olap');
  return olapTablesFromTypes(mod.types, olapUseOptions(use?.params ?? {})).tables;
}

test('the target prefers --olap-url, then CLICKHOUSE_URL, then OLAP_URL', () => {
  assert.equal(olapTarget({}, undefined), null);
  const env = { CLICKHOUSE_URL: 'http://ch:8123/', OLAP_URL: 'http://old:8123', CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p' };
  assert.deepEqual(olapTarget(env, undefined), { url: 'http://ch:8123', user: 'u', password: 'p' });
  assert.deepEqual(olapTarget(env, 'http://explicit:8123'), { url: 'http://explicit:8123', user: 'u', password: 'p' });
  assert.deepEqual(olapTarget({ OLAP_URL: 'http://old:8123' }, undefined), { url: 'http://old:8123', user: undefined, password: undefined });
});

test('each table is one CREATE TABLE over HTTP, credentials in headers', async () => {
  const server = await mockHttp(() => ({ status: 200, body: 'Ok' }));
  try {
    const applied = await applyClickhouseSchema(tables(), {
      url: server.base,
      user: 'arcod',
      password: 'secret',
      timeoutMs: 5000,
    });
    assert.deepEqual(applied, ['DeliveryEvent', 'DayRow']);
    assert.equal(server.requests.length, 2);
    for (const request of server.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['x-clickhouse-user'], 'arcod');
      assert.equal(request.headers['x-clickhouse-key'], 'secret');
      const query = new URL(request.url, 'http://localhost').searchParams.get('query');
      assert.match(query ?? '', /^CREATE TABLE IF NOT EXISTS /);
      assert.match(query ?? '', /ENGINE = MergeTree/);
    }
    const queries = server.requests.map((request) => new URL(request.url, 'http://localhost').searchParams.get('query') ?? '');
    assert.match(queries[0], /"DeliveryEvent"/);
    assert.match(queries[0], /ORDER BY \("day"\)/);
    assert.match(queries[1], /"DayRow"/);
  } finally {
    await server.stop();
  }
});

test('a refused table names itself and the status', async () => {
  const server = await mockHttp(() => ({ status: 500, body: { error: 'boom' } }));
  try {
    await assert.rejects(
      () => applyClickhouseSchema(tables(), { url: server.base, timeoutMs: 5000 }),
      /ClickHouse refused DeliveryEvent \(500\)/,
    );
    // The first table failed, so the second was never sent.
    assert.equal(server.requests.length, 1);
  } finally {
    await server.stop();
  }
});

test('an unreachable target is refused with the address, not a bare fetch error', async () => {
  const server = await mockHttp(() => ({ status: 200, body: 'Ok' }));
  await server.stop();
  await assert.rejects(
    () => applyClickhouseSchema(tables(), { url: server.base, timeoutMs: 5000 }),
    (error: Error) => error.message.includes('cannot reach ClickHouse at ' + server.base),
  );
});

// Async, not spawnSync: this process hosts the mock ClickHouse, so a blocking
// wait would stop it from answering the child it started.
function run(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('CLICKHOUSE_') && key !== 'OLAP_URL') clean[key] = value;
  }
  return new Promise((done) => {
    const child = spawn(process.execPath, ['bin/arcod.mjs', 'migrate', dir, '--json', ...args], {
      cwd: ROOT,
      env: { ...clean, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('close', (code: number | null) => done({ out, err, code: code ?? 1 }));
  });
}

async function specDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-migrate-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  return dir;
}

test('migrate without a target writes the schema and calls nobody', async () => {
  const dir = await specDir();
  const result = await run(dir, []);
  assert.equal(result.code, 0, result.err);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DeliveryEvent"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DayRow"/);
  const payload = JSON.parse(result.out);
  assert.deepEqual(payload.olap.tables, ['DeliveryEvent', 'DayRow']);
  assert.equal(payload.olap.applied, false);
  assert.equal(payload.olap.artifact, '.arcod/build/clickhouse/schema.sql');
});

test('migrate --olap-url creates the tables and reports them', async () => {
  const dir = await specDir();
  const server = await mockHttp(() => ({ status: 200, body: 'Ok' }));
  try {
    const result = await run(dir, ['--olap-url', server.base], { CLICKHOUSE_USER: 'arcod', CLICKHOUSE_PASSWORD: 'secret' });
    assert.equal(result.code, 0, result.err);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].headers['x-clickhouse-user'], 'arcod');
    const payload = JSON.parse(result.out);
    assert.equal(payload.olap.applied, true);
    assert.equal(payload.olap.url, server.base);
    assert.deepEqual(payload.olap.tables, ['DeliveryEvent', 'DayRow']);
  } finally {
    await server.stop();
  }
});

test('a migration that cannot reach ClickHouse exits 1 and keeps the schema file', async () => {
  const dir = await specDir();
  const server = await mockHttp(() => ({ status: 200, body: 'Ok' }));
  await server.stop();
  const result = await run(dir, ['--olap-url', server.base]);
  assert.equal(result.code, 1);
  assert.match(result.out, /"error": "olap: /);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DeliveryEvent"/);
});
