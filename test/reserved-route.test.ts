// /healthz and /metrics are answered by the runtime before the router. A
// declared operation at either path was silently unreachable: check was clean,
// the build succeeded, and the probe answered instead of the handler. A092
// names the route; any other path is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function spec(routes: string[]): string {
  const ops = routes.map((route, index) => [
    '    public op op' + index + '() -> string {',
    '      route: "' + route + '"',
    '    }',
    '',
  ].join(String.fromCharCode(10)));
  return [
    'module reserved @0.1.0 {}',
    '',
    'service Reserved : http {',
    '  contract {',
    ...ops,
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
}

function diagnostics(routes: string[], code: string) {
  return check(parse(spec(routes), 'reserved.arc')).filter((item) => item.code === code);
}

test('A092: a declared GET /healthz is shadowed by the probe', () => {
  const hits = diagnostics(['GET /healthz'], 'A092');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'error');
  assert.match(hits[0].message, /HEAD|GET/);
  assert.match(hits[0].message, /health probe/);
  assert.match(hits[0].hint ?? '', /\/healthz/);
});

test('A092: /metrics is the scrape, on any method', () => {
  const hits = diagnostics(['POST /metrics'], 'A092');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /metrics endpoint/);
});

test('A092: another path stays clean, and HEAD is part of the rule', () => {
  assert.equal(diagnostics(['GET /v1/health', 'HEAD /v1/health', 'GET /metrics/v1'], 'A092').length, 0);
  const head = diagnostics(['HEAD /healthz'], 'A092');
  assert.equal(head.length, 1, 'HEAD is shadowed too; the probe answers it');
});
