// Two route clauses on one operation: the router, OpenAPI and the client all
// read the first one, so the second was dead text that looked like a live
// endpoint. A082 names it instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const spec = (clauses: string[]): string => [
  'module routes @0.1.0 {}',
  '',
  'service S : http {',
  '  contract {',
  '    public op ping() -> string {',
  ...clauses.map((clause) => '      ' + clause),
  '    }',
  '  }',
  '}',
].join('\n');

test('A082: a second route is refused', () => {
  const diags = check(parse(spec(['route: "GET /v1/ping"', 'route: "GET /v1/pong"']), 'routes.arc'))
    .filter((diag) => diag.code === 'A082');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, 'ping declares a second route clause; only the first one is emitted');
  assert.equal(diags[0].path, 'services.S.contract.ping.route');
});

test('A082: a second roles or owner clause is refused too', () => {
  const source = [
    'module routes @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    auth op read(id: string) -> string {',
    '      route: "GET /v1/notes/:id"',
    '      roles: admin',
    '      roles: user',
    '      owner: id',
    '      owner: id',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const messages = check(parse(source, 'routes.arc')).filter((diag) => diag.code === 'A082').map((diag) => diag.message);
  assert.deepEqual(messages, [
    'read declares a second roles clause; only the first one is emitted',
    'read declares a second owner clause; only the first one is emitted',
  ]);
});

test('A082: one route stays clean', () => {
  const diags = check(parse(spec(['route: "GET /v1/ping"']), 'routes.arc')).filter((diag) => diag.code === 'A082');
  assert.deepEqual(diags, []);
});
