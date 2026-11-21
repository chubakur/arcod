// order by a list or record field was a silent no-op on kv (String() is
// "[object Object]" for every record) and a JSON-text sort on sql, so the same
// order answered two different pages. Only a scalar has an order; both drivers
// share the check and answer 400 with the field and its kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, tags: list<string>, meta: map<string, int>, size: int }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tags: list<string>, meta: map<string, int>, size: int) -> { id: uuid } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op scan(mode: string) -> { items: list<Item> } {',
  '      route: "POST /v1/scan"',
  '      effects: store.find',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  put: [
    'export async function put(input, io) {',
    '  const record = { id: io.new(), tags: input.tags, meta: input.meta, size: input.size };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "size");',
    '  const order = mode === "tags" ? "tags asc" : mode === "meta" ? "meta asc" : mode === "id" ? "id asc" : "size asc";',
    '  const page = await io.find("Item", { order });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: order by a list or record is 400, a scalar still sorts', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { tags: ['x'], meta: { a: 1 }, size: 2 });
    assert.equal(put.status, 201, 'seed insert succeeds');

    const tags = await post(svc.base + '/v1/scan', { mode: 'tags' });
    assert.equal(tags.status, 400, 'order by a list is Invalid');
    assert.match(String((await tags.json()).message), /order: field "tags" is a list/);

    const meta = await post(svc.base + '/v1/scan', { mode: 'meta' });
    assert.equal(meta.status, 400, 'order by a record is Invalid');
    assert.match(String((await meta.json()).message), /order: field "meta" is a map/);

    const size = await post(svc.base + '/v1/scan', { mode: 'size' });
    assert.equal(size.status, 201, 'a scalar order still answers a page');
    assert.equal((await size.json()).items.length, 1);

    const id = await post(svc.base + '/v1/scan', { mode: 'id' });
    assert.equal(id.status, 201, 'the id is a scalar too');
  } finally {
    await svc.stop();
  }
});
