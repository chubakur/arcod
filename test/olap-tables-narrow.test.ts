// B95.3 follow-up: only the record types a body names become ClickHouse
// tables. A module declares request/response records next to its facts, and
// every record type used to get DDL — the adapter map is embedded in the
// service, so a DTO turned into a table nobody writes. The bodies are the
// evidence, and anything the scan cannot read falls back to every record type:
// a missing table would turn a write into a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { olapTableNamesFromBodies } from '../src/emit/olap.ts';

const DECLARED = ['Ack', 'DayRow', 'DeliveryEvent'];

test('the scan reads the record names the bodies name', () => {
  const bodies = {
    record: 'await io.olapAppend("DeliveryEvent", { id: input.id });',
    daily: 'await io.olapSelect("DeliveryEvent", { groupBy: ["day"] }); await io.olapSelect("DayRow", {});',
  };
  assert.deepEqual(olapTableNamesFromBodies(bodies, DECLARED), ['DayRow', 'DeliveryEvent']);
});

test('a name the model does not declare is not evidence', () => {
  assert.equal(olapTableNamesFromBodies({ record: 'io.olapAppend("NoSuchType", {})' }, DECLARED), null);
});

test('a call the scan cannot read keeps every table', () => {
  // A comment between the name and the paren breaks the strict pattern; the
  // mention count then exceeds the recognized calls and the answer stays wide.
  assert.equal(olapTableNamesFromBodies({ record: 'io.olapAppend /* later */ ("DeliveryEvent", {})' }, DECLARED), null);
});

test('bodies that never mention the capability name no table', () => {
  assert.deepEqual(olapTableNamesFromBodies({ record: 'return { result: { ok: true } };' }, DECLARED), []);
});

test('a computed name, raw SQL or missing bodies keeps every table', () => {
  assert.equal(olapTableNamesFromBodies({ record: 'const T = "DeliveryEvent"; io.olapAppend(T, {})' }, DECLARED), null);
  assert.equal(olapTableNamesFromBodies({ record: 'io.olapAppend("Delivery" + suffix, {})' }, DECLARED), null);
  assert.equal(olapTableNamesFromBodies({ daily: 'io.olapSql("SELECT count() FROM events")' }, DECLARED), null);
  assert.equal(olapTableNamesFromBodies(undefined, DECLARED), null);
});

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int, at: datetime }',
  'type DayRow = { day: string, total: int }',
  'type Ack = { ok: bool }',
  '',
  'service Analytics : http {',
  '  uses events: olap',
  '',
  '  effects {',
  '    allow events.append',
  '  }',
  '',
  '  contract {',
  '    public op record(id: string, day: string, bytes: int) -> Ack {',
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

const BODY = [
  'export async function record(input, io) {',
  '  await io.olapAppend("DeliveryEvent", { id: input.id, day: input.day, bytes: input.bytes, at: input.day });',
  '  return { result: { ok: true } };',
  '}',
].join('\n');

async function buildWith(body: string, impl = true, lib?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-narrow-'));
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'record.mjs'), body);
  if (lib) await writeFile(join(dir, 'impl', 'lib.mjs'), lib);
  await buildExample(parse(SPEC, 'main.arc'), dir, impl ? { implDir: join(dir, 'impl') } : { implDir: null });
  return dir;
}

test('the schema and the adapter carry only the table the body appends', async () => {
  const dir = await buildWith(BODY);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DeliveryEvent" \(/);
  assert.doesNotMatch(sql, /"DayRow"/);
  assert.doesNotMatch(sql, /"Ack"/);
  const service = await readFile(join(dir, '.arcod', 'build', 'service', 'index.mjs'), 'utf8');
  // The relational store facade still describes every record type (STORES);
  // only the ClickHouse map the adapter reads must be narrow.
  const olapMap = /const OLAP_TABLES = (.+);/.exec(service)?.[1] ?? '';
  assert.match(olapMap, /"DeliveryEvent"/);
  assert.doesNotMatch(olapMap, /"DayRow"/);
  assert.doesNotMatch(olapMap, /"Ack"/);
});

test('a body that computes the name keeps every record type', async () => {
  const dir = await buildWith(BODY.replace('io.olapAppend("DeliveryEvent"', 'io.olapAppend(table'));
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /"DeliveryEvent"/);
  assert.match(sql, /"DayRow"/);
  assert.match(sql, /"Ack"/);
});

test('a helper in impl/lib.mjs names its table too', async () => {
  const lib = [
    'export async function appendDay(io, row) {',
    '  return io.olapAppend("DayRow", row);',
    '}',
  ].join('\n');
  const dir = await buildWith(BODY, true, lib);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /"DeliveryEvent"/);
  assert.match(sql, /"DayRow"/);
  assert.doesNotMatch(sql, /"Ack"/);
});

test('a helper with a computed name keeps every record type', async () => {
  const lib = 'export async function appendDay(io, table, row) {\n  return io.olapAppend(table, row);\n}\n';
  const dir = await buildWith(BODY, true, lib);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /"DeliveryEvent"/);
  assert.match(sql, /"DayRow"/);
  assert.match(sql, /"Ack"/);
});

test('a scaffold build (no bodies) keeps every record type', async () => {
  const dir = await buildWith(BODY, false);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /"DeliveryEvent"/);
  assert.match(sql, /"DayRow"/);
});
