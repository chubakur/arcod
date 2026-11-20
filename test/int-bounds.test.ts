// adopt maps OpenAPI `minimum`/`maximum` on an integer to
// `int(min:, max:)`. The arguments must reach the two places a client sees:
// the schema it reads and the 400 it gets. Before this, both dropped the bounds
// and an adopted contract accepted values its source rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { startService } from './harness.ts';

const source = [
  'module demo @0.1.0 {',
  '}',
  '',
  'service Items : http {',
  '  contract {',
  '    public op page(limit: int(min: 1, max: 10)) -> { limit: int } {',
  '      route: "GET /v1/page"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const impl = 'export async function page(input) { return { result: { limit: Number(input.limit) } }; }';

test('the integer bounds reach the OpenAPI parameter', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const param = (doc.paths as any)['/v1/page'].get.parameters[0];
  assert.equal(param.name, 'limit');
  assert.deepEqual(param.schema, { type: 'integer', minimum: 1, maximum: 10 });
});

test('the service answers 400 outside the bound and 200 inside it', async () => {
  assert.deepEqual(check(parse(source, 'main.arc')).filter((item) => item.severity === 'error'), []);
  const svc = await startService(source, { impl: { page: impl } });
  try {
    const ok = await fetch(svc.base + '/v1/page?limit=5');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { limit: 5 });
    for (const [value, message] of [
      ['0', /must be >= 1/],
      ['11', /must be <= 10/],
      ['1.5', /must be an integer/],
      ['abc', /must be an integer/],
    ] as const) {
      const bad = await fetch(svc.base + '/v1/page?limit=' + value);
      assert.equal(bad.status, 400, value + ' is refused');
      assert.match((await bad.json()).message, message);
    }
  } finally {
    await svc.stop();
  }
});
