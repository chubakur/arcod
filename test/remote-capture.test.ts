// remoteCall decides whether a parameter is a path capture by looking for
// ':' + name inside the route. A parameter named `item` therefore matched the
// capture `:itemId` as a prefix: the path was rewritten and `item` never made
// it into the query string, so the call went to a URL that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';

const SPEC = [
  'module remotecapture @0.1.0 {',
  '}',
  '',
  'external service Catalog : http {',
  '  contract {',
  '    op find(item: string, itemId: string) -> { ok: bool } {',
  '      route: "GET /v1/things/:itemId"',
  '    }',
  '  }',
  '}',
  '',
  'service Proxy : http {',
  '  effects {',
  '    allow Catalog.find',
  '  }',
  '',
  '  contract {',
  '    public op find(item: string, itemId: string) -> { raw: string } {',
  '      route: "POST /v1/find"',
  '      effects: Catalog.find',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind Catalog -> endpoint(url: "http://catalog.example.com")',
  '}',
].join('\n');

const IMPL = {
  find: [
    'export async function find(input, io) {',
    '  const out = await io.remote("Catalog", "find", { item: input.item, itemId: input.itemId });',
    '  return { result: { raw: JSON.stringify(out.body) } };',
    '}',
  ].join('\n'),
};

test('a parameter whose name prefixes a capture is a query parameter', async () => {
  const catalog = await mockHttp(() => ({ status: 200, body: { ok: true } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { CATALOG_URL: catalog.base } });
  try {
    const res = await fetch(svc.base + '/v1/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: 'a b', itemId: 'n1' }),
    });
    assert.equal(res.status, 201);

    assert.equal(catalog.requests.length, 1, 'one call to the catalog');
    const call = catalog.requests[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url, '/v1/things/n1?item=a+b', 'only the whole capture fills the path');
    assert.equal(call.body, '');
  } finally {
    await svc.stop();
    await catalog.stop();
  }
});

