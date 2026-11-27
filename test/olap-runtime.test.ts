// B95.3: the adapter a generated service carries for the olap capability. The
// builders in src/emit/olap.ts are compile-time; this file proves the runtime
// half — one HTTP call to ClickHouse per effect, columns checked against the
// declared record, values sent as parameters and never interpolated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockHttp } from './harness.ts';
import { parse } from '../src/parser.ts';
import { olapTablesFromTypes } from '../src/emit/olap.ts';
import { olapRuntime } from '../src/emit/olap-runtime.ts';

const SPEC = [
  'module demo @0.1.0 {}',
  '',
  'type DeliveryEvent = {',
  '  id: string,',
  '  day: string,',
  '  bytes: int,',
  '  at: datetime,',
  '  note: optional<string>,',
  '}',
  '',
  'type NotATable = { id: string }',
  '',
].join('\n');

async function loadAdapter(tables: { name: string; columns: Array<{ name: string; type: string }>; orderBy: string[]; ttl?: string }[], url: string) {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-'));
  const file = join(dir, 'adapter.mjs');
  const source = olapRuntime(tables as never)
    + '\nexport { olapAppend, olapSelect, olapSql, olapPing };\n';
  await writeFile(file, source, 'utf8');
  process.env.CLICKHOUSE_URL = url;
  const mod = await import(pathToFileURL(file).href);
  return mod as {
    olapAppend: (entity: string, record: unknown) => Promise<void>;
    olapSelect: (entity: string, query: unknown) => Promise<Array<Record<string, unknown>>>;
    olapSql: (sql: string, params?: unknown) => Promise<Array<Record<string, unknown>>>;
    olapPing: () => Promise<void>;
  };
}

function tables() {
  const mod = parse(SPEC, 'main.arc');
  return olapTablesFromTypes(mod.types);
}

test('every record type becomes a table with its declared columns', () => {
  const { tables: list, problems } = tables();
  assert.deepEqual(problems, []);
  const delivery = list.find((table) => table.name === 'DeliveryEvent');
  assert.ok(delivery);
  assert.deepEqual(delivery!.columns.map((column) => column.name), ['id', 'day', 'bytes', 'at', 'note']);
  assert.equal(delivery!.columns.find((column) => column.name === 'bytes')!.type, 'Int64');
  assert.equal(delivery!.columns.find((column) => column.name === 'at')!.type, 'DateTime64(3)');
  assert.equal(delivery!.columns.find((column) => column.name === 'note')!.type, 'Nullable(String)');
});

test('orderBy names a missing column and ttl needs a datetime column', () => {
  const mod = parse(SPEC, 'main.arc');
  const bad = olapTablesFromTypes(mod.types, { orderBy: ['nope'], ttl: true });
  assert.ok(bad.problems.some((problem) => /DeliveryEvent: orderBy names nope/.test(problem)));
  const typed = olapTablesFromTypes(mod.types.filter((decl) => decl.name === 'NotATable'), { ttl: true });
  assert.ok(typed.problems.some((problem) => /ttl needs a datetime column/.test(problem)));
  const good = olapTablesFromTypes(mod.types, { orderBy: ['at'], ttl: true });
  const delivery = good.tables.find((table) => table.name === 'DeliveryEvent')!;
  assert.deepEqual(delivery.orderBy, ['at']);
  assert.equal(delivery.ttl, 'at');
});

test('append writes one JSONEachRow row and refuses a column the record lacks', async () => {
  const clickhouse = await mockHttp(() => ({ status: 200, body: {} }));
  const adapter = await loadAdapter(tables().tables, clickhouse.base);
  try {
    await adapter.olapAppend('DeliveryEvent', { id: 'e1', day: '2026-11-27', bytes: 10, at: '2026-11-27T10:00:00Z' });
    const insert = clickhouse.requests[0];
    const insertQuery = new URL(insert.url, 'http://localhost').searchParams.get('query') ?? '';
    assert.match(insertQuery, /INSERT INTO "DeliveryEvent" FORMAT JSONEachRow/);
    const row = JSON.parse(insert.body.trim());
    assert.equal(row.bytes, 10);
    assert.equal(row.note, null);
    await assert.rejects(
      () => adapter.olapAppend('DeliveryEvent', { id: 'e2', day: 'd', bytes: 1, at: 'x', extra: 1 }),
      /column "extra" does not exist on DeliveryEvent/,
    );
    await assert.rejects(() => adapter.olapAppend('Ghost', { id: 'x' }), /table "Ghost" is not declared/);
    assert.equal(clickhouse.requests.length, 1, 'a refused record never reaches the network');
  } finally {
    await clickhouse.stop();
  }
});

test('select sends a typed query with parameters and reads FORMAT JSON rows', async () => {
  const clickhouse = await mockHttp(() => ({ status: 200, body: { data: [{ day: '2026-11-27', total: 10 }] } }));
  const adapter = await loadAdapter(tables().tables, clickhouse.base);
  try {
    const rows = await adapter.olapSelect('DeliveryEvent', {
      where: { day: { in: ['2026-11-27', '2026-11-28'] } },
      groupBy: ['day'],
      metrics: [{ name: 'total', op: 'sum', field: 'bytes' }],
      order: 'day desc',
      limit: 5,
    });
    assert.deepEqual(rows, [{ day: '2026-11-27', total: 10 }]);
    const request = clickhouse.requests[0];
    const sql = new URL(request.url, 'http://localhost').searchParams.get('query') ?? '';
    assert.match(sql, /SELECT "day", sum\("bytes"\) AS "total"/);
    assert.match(sql, /FROM "DeliveryEvent"/);
    assert.match(sql, /WHERE "day" IN \(\{p1:String\}, \{p2:String\}\)/);
    assert.match(sql, /GROUP BY "day"/);
    assert.match(sql, /ORDER BY "day" DESC/);
    assert.match(sql, /LIMIT 5/);
    assert.match(sql, /FORMAT JSON$/);
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.searchParams.get('param_p1'), '2026-11-27');
    assert.equal(url.searchParams.get('param_p2'), '2026-11-28');
    await assert.rejects(
      () => adapter.olapSelect('DeliveryEvent', { groupBy: ['nope'] }),
      /unknown column "nope"/,
    );
  } finally {
    await clickhouse.stop();
  }
});

test('a distinct count is spelled count(DISTINCT column) so a retry does not inflate it', async () => {
  const clickhouse = await mockHttp(() => ({ status: 200, body: { data: [{ uniq: 1 }] } }));
  const adapter = await loadAdapter(tables().tables, clickhouse.base);
  try {
    await adapter.olapSelect('DeliveryEvent', { metrics: [{ name: 'uniq', op: 'count', field: 'id', distinct: true }] });
    assert.match(new URL(clickhouse.requests[0].url, 'http://localhost').searchParams.get('query') ?? '', /count\(DISTINCT "id"\) AS "uniq"/);
  } finally {
    await clickhouse.stop();
  }
});

test('raw sql accepts one read-only statement and refuses a write before the network', async () => {
  const clickhouse = await mockHttp(() => ({ status: 200, body: { data: [{ one: 1 }] } }));
  const adapter = await loadAdapter(tables().tables, clickhouse.base);
  try {
    await assert.rejects(() => adapter.olapSql('DROP TABLE "DeliveryEvent"'), /one read-only statement/);
    await assert.rejects(() => adapter.olapSql('SELECT 1; DROP TABLE "DeliveryEvent"'), /one read-only statement/);
    assert.equal(clickhouse.requests.length, 0);
    const rows = await adapter.olapSql('SELECT 1 AS one FORMAT JSON', {});
    assert.deepEqual(rows, [{ one: 1 }]);
    assert.equal(new URL(clickhouse.requests[0].url, 'http://localhost').searchParams.get('query'), 'SELECT 1 AS one FORMAT JSON');
  } finally {
    await clickhouse.stop();
  }
});

test('a ping is SELECT 1 and a ClickHouse error is Unavailable, not a 500 body', async () => {
  const ok = await mockHttp(() => ({ status: 200, body: { data: [] } }));
  const adapter = await loadAdapter(tables().tables, ok.base);
  try {
    await adapter.olapPing();
    assert.equal(new URL(ok.requests[0].url, 'http://localhost').searchParams.get('query'), 'SELECT 1');
  } finally {
    await ok.stop();
  }
  const broken = await mockHttp(() => ({ status: 500, body: { error: 'boom' } }));
  const failing = await loadAdapter(tables().tables, broken.base);
  try {
    await assert.rejects(() => failing.olapPing(), (error: Error & { error?: string }) => {
      assert.equal(error.error, 'Unavailable');
      assert.match(error.message, /ClickHouse answered 500/);
      return true;
    });
  } finally {
    await broken.stop();
  }
});
