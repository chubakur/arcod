// The remote client builds a request from the declared route. GET and DELETE
// put non-path parameters in the query string; every other method puts them in a
// JSON body. HEAD was in neither group, so it was sent with a body — and undici
// refuses "Request with GET/HEAD method cannot have body", so a declared HEAD
// operation of an external service could never be called from an impl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, mockHttp } from './harness.ts';

const SPEC = [
  'module remotemethods @0.1.0 {',
  '}',
  '',
  'external service Catalog : http {',
  '  contract {',
  '    op peek(id: string, tag: string) -> { ok: bool } {',
  '      route: "HEAD /v1/items/:id"',
  '    }',
  '',
  '    op list(tag: string) -> { ok: bool } {',
  '      route: "GET /v1/items"',
  '    }',
  '',
  '    op drop(id: string) -> { ok: bool } {',
  '      route: "DELETE /v1/items/:id"',
  '    }',
  '',
  '    op upsert(name: string) -> { ok: bool } {',
  '      route: "POST /v1/items"',
  '    }',
  '  }',
  '}',
  '',
  'service Proxy : http {',
  '  effects {',
  '    allow Catalog.peek, Catalog.list, Catalog.drop, Catalog.upsert',
  '  }',
  '',
  '  contract {',
  '    public op peek(id: string, tag: string) -> { status: int, raw: string } {',
  '      route: "POST /v1/peek"',
  '      effects: Catalog.peek',
  '      post: result != null',
  '    }',
  '',
  '    public op list(tag: string) -> { status: int, raw: string } {',
  '      route: "POST /v1/list"',
  '      effects: Catalog.list',
  '      post: result != null',
  '    }',
  '',
  '    public op drop(id: string) -> { status: int, raw: string } {',
  '      route: "POST /v1/drop"',
  '      effects: Catalog.drop',
  '      post: result != null',
  '    }',
  '',
  '    public op upsert(name: string) -> { status: int, raw: string } {',
  '      route: "POST /v1/upsert"',
  '      effects: Catalog.upsert',
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
  peek: [
    'export async function peek(input, io) {',
    '  const out = await io.remote("Catalog", "peek", { id: input.id, tag: input.tag });',
    '  return { result: { status: out.status, raw: JSON.stringify(out.body) } };',
    '}',
  ].join('\n'),
  list: [
    'export async function list(input, io) {',
    '  const out = await io.remote("Catalog", "list", { tag: input.tag });',
    '  return { result: { status: out.status, raw: JSON.stringify(out.body) } };',
    '}',
  ].join('\n'),
  drop: [
    'export async function drop(input, io) {',
    '  const out = await io.remote("Catalog", "drop", { id: input.id });',
    '  return { result: { status: out.status, raw: JSON.stringify(out.body) } };',
    '}',
  ].join('\n'),
  upsert: [
    'export async function upsert(input, io) {',
    '  const out = await io.remote("Catalog", "upsert", { name: input.name });',
    '  return { result: { status: out.status, raw: JSON.stringify(out.body) } };',
    '}',
  ].join('\n'),
};

async function call(base: string, op: string, payload: Record<string, unknown>) {
  const res = await fetch(base + '/v1/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as { status: number; raw: string } };
}

test('a HEAD operation of an external service is called without a body', async () => {
  const catalog = await mockHttp(() => ({ status: 200, body: { ok: true } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { CATALOG_URL: catalog.base } });
  try {
    const answer = await call(svc.base, 'peek', { id: 'a b', tag: 'x' });
    assert.equal(answer.status, 201, 'the proxy answers for the HEAD probe');
    assert.equal(answer.body.status, 200, 'a HEAD answer mirrors GET');

    assert.equal(catalog.requests.length, 1, 'one call to the catalog');
    const call1 = catalog.requests[0];
    assert.equal(call1.method, 'HEAD');
    assert.equal(call1.url, '/v1/items/a%20b?tag=x', 'the path parameter is encoded, the rest becomes a query');
    assert.equal(call1.body, '', 'HEAD carries no body');
  } finally {
    await svc.stop();
    await catalog.stop();
  }
});

test('GET and DELETE remote calls stay body-less with a query string', async () => {
  const catalog = await mockHttp(() => ({ status: 200, body: { ok: true } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { CATALOG_URL: catalog.base } });
  try {
    assert.equal((await call(svc.base, 'list', { tag: 'y' })).status, 201);
    assert.equal((await call(svc.base, 'drop', { id: 'n1' })).status, 201);

    assert.deepEqual(
      catalog.requests.map((request) => [request.method, request.url, request.body]),
      [
        ['GET', '/v1/items?tag=y', ''],
        ['DELETE', '/v1/items/n1', ''],
      ],
    );
  } finally {
    await svc.stop();
    await catalog.stop();
  }
});

test('a POST remote call still carries a JSON body and its type', async () => {
  const catalog = await mockHttp(() => ({ status: 200, body: { ok: true } }));
  const svc = await startService(SPEC, { impl: IMPL, env: { CATALOG_URL: catalog.base } });
  try {
    assert.equal((await call(svc.base, 'upsert', { name: 'thing' })).status, 201);
    assert.equal(catalog.requests.length, 1);
    const request = catalog.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/items', 'a body method puts no parameters in the query');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { name: 'thing' });
  } finally {
    await svc.stop();
    await catalog.stop();
  }
});

