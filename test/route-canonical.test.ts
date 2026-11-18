// A path with an empty segment or a trailing slash is one route to the router
// (it drops empty segments) and one route to A069. The OpenAPI document now
// lists the canonical spelling, so the documented path must really be served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';

const SPEC = `module canon @0.1.0 {}

service Canon : http {
  contract {
    public op items() -> { ok: bool } {
      route: "GET /v1//items/"
    }
  }
}
`;

test('the documented canonical path is the one the router serves', async () => {
  const mod = parse(SPEC, 'main.arc');
  assert.deepEqual(check(mod).filter((d) => d.severity === 'error'), []);
  const paths = emitOpenapi(mod).paths as Record<string, any>;
  assert.deepEqual(Object.keys(paths), ['/v1/items']);

  const service = await startService(SPEC, {
    impl: { items: 'export async function items() { return { result: { ok: true } }; }' },
  });
  try {
    const response = await fetch(service.base + '/v1/items');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await service.stop();
  }
});
