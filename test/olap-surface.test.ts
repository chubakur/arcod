// B95.1 declared the olap capability and its ClickHouse provider; B95.3 gave
// them a driver, so bind and uses are served rather than refused (the A083
// guard that held the surface safe until the adapter landed is gone). These
// assertions keep the surface itself honest: effects, environment, tables.
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

test('clickhouse declares the olap capability and its environment', () => {
  const provider = PROVIDERS.clickhouse;
  assert.equal(provider.capability, 'olap');
  assert.equal(provider.port, 8123);
  assert.match(provider.appEnv!({ host: 'clickhouse', port: 8123 } as never).CLICKHOUSE_URL, /^http:\/\/clickhouse:8123$/);
  // B95.3 shipped the adapter, so the provider promises nothing it lacks.
  assert.equal(provider.noRuntime, undefined);
});

test('the olap capability declares append, select and the raw escape hatch', () => {
  const olap = capabilityFor('olap');
  assert.ok(olap);
  assert.deepEqual(Object.keys(olap!.effects).sort(), ['append', 'select', 'sql']);
  assert.match(olap!.effects.select, /groupBy/);
  assert.match(olap!.notes ?? '', /distinct/);
});

test('a bound clickhouse serves olap: the adapter is the driver', () => {
  const diags = check(parse(spec('bind events -> clickhouse'), 'main.arc'));
  assert.equal(diags.filter((item) => item.code === 'A083').length, 0);
  assert.equal(diags.filter((item) => item.severity === 'error').length, 0, JSON.stringify(diags));
  // The surface test in olap-live proves the driver answers; here the provider
  // simply must not promise a runtime it lacks.
  assert.equal(PROVIDERS.clickhouse.noRuntime, undefined);
});

test('a bind to another provider does not claim olap', () => {
  const diags = check(parse(spec('bind events -> redis'), 'main.arc'));
  assert.ok(diags.some((item) => item.code === 'A024' && /does not implement olap/.test(item.message)));
});
