// B95.2 (build slice): the ClickHouse schema travels with the build the same
// way SQL migrations do, from the same table map the adapter carries. A table
// the schema never created is a store the body cannot reach, so the two are
// generated from one list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int, at: datetime, note: optional<string> }',
  '',
  'service Analytics : http {',
  '  uses events: olap(orderBy: "at", ttl: 30d)',
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

test('the build writes a ClickHouse schema from the declared records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-build-'));
  await buildExample(parse(SPEC, 'main.arc'), dir, { impl: {} });
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DeliveryEvent" \(/);
  assert.match(sql, /"bytes" Int64/);
  assert.match(sql, /"at" DateTime64\(3\)/);
  assert.match(sql, /"note" Nullable\(String\)/);
  assert.match(sql, /ENGINE = MergeTree/);
  assert.match(sql, /ORDER BY \("at"\)/);
  assert.match(sql, /TTL toDateTime\("at"\)/);
});

test('a service without the capability writes no ClickHouse schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-none-'));
  const spec = SPEC.replace('uses events: olap(orderBy: "at", ttl: 30d)', 'uses store: kv')
    .replace('allow events.append, ', '')
    .replace('allow events.append', 'allow store.get, store.set')
    .replace('effects: events.append', 'effects: store.get, store.set')
    .replace('bind events -> clickhouse', 'bind store -> redis');
  await buildExample(parse(spec, 'main.arc'), dir, { impl: {} });
  await assert.rejects(() => readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8'), /ENOENT/);
});
