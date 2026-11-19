// `uses analytics: olap` passed check: clickhouse declares the capability,
// so it looked bound, but no effect list and no adapter existed — the
// generated service knew nothing about the alias. A076 rejects it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function spec(capability: string, effect: string): string {
  const lines = [
    'module analytics @0.1.0 {',
    '}',
    '',
    'type Event = { id: uuid, name: string }',
    '',
    'service Analytics : http {',
    '  uses analytics: ' + capability,
    '  uses uuid: ids',
    '',
    '  effects {',
    '    allow analytics.' + effect + ', uuid.new',
    '  }',
    '',
    '  contract {',
    '    public op track(name: string) -> Event {',
    '      route: "POST /v1/events"',
    '      effects: analytics.' + effect + ', uuid.new',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind analytics -> clickhouse',
    '  bind uuid -> local',
    '  deploy docker',
    '}',
  ];
  return lines.join('\n');
}

test('a capability with no effects and no adapter is an error', () => {
  const mod = parse(spec('olap', 'insert'), 'main.arc');
  const found = check(mod).filter((item) => item.code === 'A076');
  assert.deepEqual(found.map((item) => [item.severity, item.path, item.message]), [
    ['error', 'services.Analytics.uses.analytics', 'capability olap has no effects and no adapter'],
  ]);
});

test('an invented capability and an invented effect are not silent', () => {
  const mod = parse(spec('warehouse', 'query'), 'main.arc');
  const found = check(mod).filter((item) => item.code === 'A076');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /capability warehouse has no effects and no adapter/);
});

test('a real capability stays clean', () => {
  const source = [
    'module rooms @0.1.0 {',
    '}',
    '',
    'service Rooms : http {',
    '  uses store: kv',
    '',
    '  contract {',
    '    public op read(id: string) -> string {',
    '      route: "GET /v1/rooms/:id"',
    '      effects: store.get',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  bind store -> redis(host: "kv")',
    '  deploy docker',
    '}',
  ].join('\n');
  const mod = parse(source, 'main.arc');
  assert.deepEqual(check(mod).filter((item) => item.code === 'A076'), []);
});
