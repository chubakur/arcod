// B95.3 (live): the adapter a built service carries, proven end to end. A
// generated service appends two rows over HTTP 8123 into a fake ClickHouse,
// selects them back as an aggregate, refuses a column the record lacks with a
// 400 instead of a 500, and answers /healthz only when both probes passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitService } from '../src/emit/service.ts';

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int, at: datetime }',
  '',
  'type DayRow = { day: string, total: int }',
  '',
  'service Analytics : http {',
  '  uses events: olap(orderBy: "at")',
  '',
  '  effects {',
  '    allow events.append, events.select',
  '  }',
  '',
  '  contract {',
  '    public op record(id: string, day: string, bytes: int) -> { ok: bool } {',
  '      route: "POST /v1/record"',
  '      effects: events.append',
  '    }',
  '',
  '    public op daily() -> { data: list<DayRow> } {',
  '      route: "GET /v1/daily"',
  '      effects: events.select',
  '    }',
  '',
  '    public op broken() -> { data: list<DayRow> } {',
  '      route: "GET /v1/broken"',
  '      effects: events.select',
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

const IMPL = {
  record: [
    'export async function record(input, io) {',
    '  await io.olapAppend("DeliveryEvent", { id: input.id, day: input.day, bytes: input.bytes, at: new Date().toISOString() });',
    '  return { result: { ok: true } };',
    '}',
  ].join('\n'),
  daily: [
    'export async function daily(input, io) {',
    '  const rows = await io.olapSelect("DeliveryEvent", { groupBy: ["day"], metrics: [{ name: "total", op: "sum", field: "bytes" }], order: "day asc" });',
    '  return { result: { data: rows } };',
    '}',
  ].join('\n'),
  broken: [
    'export async function broken(input, io) {',
    '  const rows = await io.olapSelect("DeliveryEvent", { groupBy: ["nope"] });',
    '  return { result: { data: rows } };',
    '}',
  ].join('\n'),
};

// A ClickHouse stand-in: INSERT lines are collected, SELECT is answered with a
// sum per day. It does not parse SQL; the assertions check the request shape,
// and this answers with the shape ClickHouse would.
function fakeClickhouse() {
  const rows: Array<{ day: string; bytes: number }> = [];
  return mockHttp((req) => {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('query') ?? '';
    if (query.startsWith('INSERT')) {
      for (const line of req.body.split('\n')) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line));
      }
      return { status: 200, body: {} };
    }
    if (query.startsWith('SELECT 1')) return { status: 200, body: { data: [{ 1: 1 }], rows: 1 } };
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.day, (totals.get(row.day) ?? 0) + row.bytes);
    return { status: 200, body: { data: [...totals.entries()].sort().map(([day, total]) => ({ day, total })), rows: totals.size } };
  });
}

test('check accepts olap on clickhouse and the emitted service carries the adapter', () => {
  const diags = check(parse(SPEC, 'main.arc'));
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0, JSON.stringify(diags));
  const source = emitService(parse(SPEC, 'main.arc'), { impl: IMPL });
  assert.match(source, /const OLAP_TABLES = \{/);
  assert.match(source, /"DeliveryEvent": \[\["id", "String"\], \["day", "String"\], \["bytes", "Int64"\], \["at", "DateTime64\(3\)"\]\]/);
  assert.match(source, /async function olapAppend\(/);
  assert.match(source, /async olapAppend\(entity, record\)/);
  assert.match(source, /olapProbe = olapPing;/);
});

test('two appends reach ClickHouse and the select answers the aggregate', async () => {
  const clickhouse = await fakeClickhouse();
  const svc = await startService(SPEC, { impl: IMPL, env: { CLICKHOUSE_URL: clickhouse.base } });
  try {
    for (const entry of [['e1', 3], ['e2', 4]] as Array<[string, number]>) {
      const res = await fetch(svc.base + '/v1/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: entry[0], day: '2026-11-27', bytes: entry[1] }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.ok, true);
    }
    const inserts = clickhouse.requests.filter((req) => (new URL(req.url, 'http://localhost').searchParams.get('query') ?? '').startsWith('INSERT'));
    assert.equal(inserts.length, 2);
    assert.equal(JSON.parse(inserts[1].body.trim()).bytes, 4);

    const res = await fetch(svc.base + '/v1/daily');
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data, [{ day: '2026-11-27', total: 7 }]);
    const select = clickhouse.requests.find((req) => (new URL(req.url, 'http://localhost').searchParams.get('query') ?? '').includes('GROUP BY'));
    assert.ok(select);
    const sql = new URL(select!.url, 'http://localhost').searchParams.get('query') ?? '';
    assert.match(sql, /sum\("bytes"\) AS "total"/);
    assert.match(sql, /FORMAT JSON$/);
  } finally {
    await svc.stop();
    await clickhouse.stop();
  }
});

test('a column the record lacks is a 400 from the adapter, not a 500', async () => {
  const clickhouse = await fakeClickhouse();
  const svc = await startService(SPEC, { impl: IMPL, env: { CLICKHOUSE_URL: clickhouse.base } });
  try {
    const res = await fetch(svc.base + '/v1/broken');
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(String(body.message ?? ''), /unknown column "nope"/);
  } finally {
    await svc.stop();
    await clickhouse.stop();
  }
});

test('healthz probes ClickHouse with SELECT 1 and names it', async () => {
  const clickhouse = await fakeClickhouse();
  const svc = await startService(SPEC, { impl: IMPL, env: { CLICKHOUSE_URL: clickhouse.base } });
  try {
    const res = await fetch(svc.base + '/healthz');
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.olap, 'up');
    assert.ok(clickhouse.requests.some((req) => (new URL(req.url, 'http://localhost').searchParams.get('query') ?? '') === 'SELECT 1'));
  } finally {
    await svc.stop();
    await clickhouse.stop();
  }
});

test('a ClickHouse that goes down degrades healthz instead of answering 200', async () => {
  // The service starts against a healthy store: startService waits for /healthz,
  // and a service that could never come up is a different test. Losing the
  // store after boot is the case that matters — the probe must stop saying ok.
  let healthy = true;
  const clickhouse = await mockHttp(() => (healthy ? { status: 200, body: { data: [] } } : { status: 502, body: {} }));
  const svc = await startService(SPEC, { impl: IMPL, env: { CLICKHOUSE_URL: clickhouse.base } });
  try {
    healthy = false;
    const res = await fetch(svc.base + '/healthz');
    const body = await res.json();
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.olap, 'down');
  } finally {
    await svc.stop();
    await clickhouse.stop();
  }
});
