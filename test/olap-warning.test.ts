// W054: io.olapSql is the escape hatch, and a body that uses it is no longer
// checked against the declared record — the query is ClickHouse's, not the
// model's. The warning names the file and the trade once, so a body that needs
// the escape hatch can keep it deliberately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int }',
  '',
  'service Analytics : http {',
  '  uses events: olap(orderBy: "day")',
  '',
  '  effects {',
  '    allow events.append, events.select, events.sql',
  '  }',
  '',
  '  contract {',
  '    public op raw() -> list<DeliveryEvent> {',
  '      route: "GET /v1/raw"',
  '      effects: events.sql',
  '    }',
  '',
  '    public op typed() -> list<DeliveryEvent> {',
  '      route: "GET /v1/typed"',
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

const RAW = "export async function raw(input, io) { const rows = await io.olapSql('SELECT day, sum(bytes) FROM \"DeliveryEvent\" GROUP BY day'); return { result: rows }; }";
const TYPED = "export async function typed(input, io) { return { result: await io.olapSelect('DeliveryEvent', { groupBy: ['day'], metrics: [{ name: 'total', op: 'sum', field: 'bytes' }] }) }; }";

function warnings(mod = parse(SPEC, 'main.arc'), impl: Record<string, string>) {
  return check(mod, { impl }).filter((item) => item.code === 'W054');
}

test('W054 names a body that sends raw SQL to ClickHouse', () => {
  const found = warnings(parse(SPEC, 'main.arc'), { raw: RAW, typed: TYPED });
  assert.deepEqual(found.map((item) => [item.severity, item.file, item.path]), [
    ['warning', 'impl/raw.mjs', 'impl.raw'],
  ]);
  assert.equal(found[0].message, 'io.olapSql sends raw SQL, which ties this body to ClickHouse');

  assert.ok((found[0].hint ?? '').includes('io.olapAppend/io.olapSelect'));
});

test('the typed calls carry no warning', () => {
  assert.deepEqual(warnings(parse(SPEC, 'main.arc'), { typed: TYPED }), []);
});

test('a module without the olap capability gets no W054', () => {
  const spec = SPEC
    .replace('uses events: olap(orderBy: "day")', 'uses events: kv')
    .replace('allow events.append, events.select, events.sql', 'allow events.get, events.set')
    .replace('effects: events.sql', 'effects: events.get')
    .replace('effects: events.select', 'effects: events.get')
    .replace('bind events -> clickhouse', 'bind events -> redis');
  assert.deepEqual(warnings(parse(spec, 'main.arc'), { raw: RAW }), []);
});
