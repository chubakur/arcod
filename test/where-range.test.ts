// gt/gte/lt/lte on a list or record has no meaning: kv compared String()
// ("a,b", "[object Object]") and sql compared the JSON column against a
// string, so the same query answered nonsense or nothing. eq/ne/in/contains
// still name a value; a range needs a scalar field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, tags: list<string>, meta: map<string, int> }',
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
  '    public op put(tags: list<string>, meta: map<string, int>) -> { id: uuid } {',
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
    '  const record = { id: io.new(), tags: input.tags, meta: input.meta };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } }',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "gt");',
    '  const where = mode === "gt"',
    '    ? { tags: { gt: "a" } }',
    '    : mode === "lte"',
    '      ? { meta: { lte: 5 } }',
    '      : mode === "eq"',
    '        ? { tags: { eq: ["a"] } }',
    '        : mode === "contains"',
    '          ? { tags: { contains: "a" } }',
    '          : { id: { gte: "0" } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: a range on a list or record is 400, equality and contains still work', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { tags: ['a'], meta: { n: 1 } });
    assert.equal(put.status, 201);

    for (const [mode, op] of [['gt', 'gt'], ['lte', 'lte']] as const) {
      const res = await post(svc.base + '/v1/scan', { mode });
      assert.equal(res.status, 400, op + ' on a container is Invalid');
      assert.match(String((await res.json()).message), new RegExp('where "' + op + '" on "'));
    }

    const eq = await post(svc.base + '/v1/scan', { mode: 'eq' });
    assert.equal(eq.status, 201);
    assert.equal((await eq.json()).items.length, 1, 'eq still compares the value');

    const contains = await post(svc.base + '/v1/scan', { mode: 'contains' });
    assert.equal(contains.status, 201);
    assert.equal((await contains.json()).items.length, 1, 'contains still searches the text');

    const scalar = await post(svc.base + '/v1/scan', { mode: 'scalar' });
    assert.equal(scalar.status, 201, 'a scalar range is still a filter');
  } finally {
    await svc.stop();
  }
});
