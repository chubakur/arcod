// B95.1: the olap capability and its ClickHouse provider are declared before
// the adapter exists. The bind is real — compose can start the container and
// OLAP_URL is set — but check must refuse a service that uses the capability,
// because the generated service has no driver and would silently write into a
// container nobody reads (A083). This is the guard that makes the declared
// surface safe until B95.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { PROVIDERS } from '../src/providers.ts';
import { capabilityFor } from '../src/capabilities.ts';

const spec = (body: string) => [
  'module demo @0.1.0 {',
  '}',
  '',
  'environment local {',
  '  ' + body,
  '}',
  '',
  'service Analytics : http {',
  '  uses events: olap(orderBy: "at")',
  '',
  '  effects {',
  '    allow events.append, events.select, events.sql',
  '  }',
  '',
  '  contract {',
  '    public op daily() -> { day: string } {',
  '      route: "GET /v1/daily"',
  '      effects: events.select',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

test('clickhouse declares the olap capability, its environment and the missing driver', () => {
  const provider = PROVIDERS.clickhouse;
  assert.equal(provider.capability, 'olap');
  assert.equal(provider.port, 8123);
  assert.match(provider.appEnv!({ host: 'clickhouse', port: 8123 } as never).CLICKHOUSE_URL, /^http:\/\/clickhouse:8123$/);
  assert.match(String(provider.noRuntime), /B95\.3/);
});

test('the olap capability declares append, select and the raw escape hatch', () => {
  const olap = capabilityFor('olap');
  assert.ok(olap);
  assert.deepEqual(Object.keys(olap!.effects).sort(), ['append', 'select', 'sql']);
  assert.match(olap!.effects.select, /groupBy/);
  assert.match(olap!.notes ?? '', /distinct/);
});

test('a bound clickhouse refuses to serve olap until the adapter lands', () => {
  const diags = check(parse(spec('bind events -> clickhouse'), 'main.arc'));
  const hit = diags.filter((item) => item.code === 'A083');
  assert.equal(hit.length, 1);
  assert.match(hit[0].message, /clickhouse cannot serve olap at runtime/);
  assert.match(String(hit[0].hint), /B95\.3/);
});

test('a bind to another provider does not claim olap', () => {
  const diags = check(parse(spec('bind events -> redis'), 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A024' && /does not implement olap/.test(item.message)));
});
