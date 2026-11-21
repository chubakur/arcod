// eq/ne/in on a record field compared JSON.stringify output on kv, so a row
// inserted as {b: 2, a: 1} did not equal the query {a: 1, b: 2} - while sql
// compares JSON values, where a record is an unordered set of keys. A list is
// ordered and keeps its order in both comparisons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, meta: map<string, int>, tags: list<string> }',
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
  '    public op put(meta: map<string, int>, tags: list<string>) -> { id: uuid } {',
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
    '  const record = { id: io.new(), meta: input.meta, tags: input.tags };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "eq");',
    '  const where = mode === "eq"',
    '    ? { meta: { eq: { a: 1, b: 2 } } }',
    '    : mode === "ne"',
    '      ? { meta: { ne: { a: 1, b: 2 } } }',
    '      : mode === "in"',
    '        ? { meta: { in: [{ a: 1, b: 2 }] } }',
    '        : mode === "other"',
    '          ? { meta: { eq: { a: 9, b: 2 } } }',
    '          : mode === "list"',
    '            ? { tags: { eq: ["x", "y"] } }',
    '            : mode === "listother"',
    '              ? { tags: { eq: ["y", "x"] } }',
    '              : { meta: { eq: { a: 1, b: 2 } } };',
    '  const page = await io.find("Item", { where });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function count(base: string, mode: string): Promise<number> {
  const res = await post(base + '/v1/scan', { mode });
  assert.equal(res.status, 201);
  return (await res.json()).items.length;
}
test('kv: a record field compares by value, key order does not matter', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { meta: { b: 2, a: 1 }, tags: ['x', 'y'] });
    assert.equal(put.status, 201, 'seed insert succeeds');

    assert.equal(await count(svc.base, 'eq'), 1, 'eq finds the same record in another key order');
    assert.equal(await count(svc.base, 'ne'), 0, 'ne does not treat it as a different record');
    assert.equal(await count(svc.base, 'in'), 1, 'in compares values too');
    assert.equal(await count(svc.base, 'other'), 0, 'a different value still does not match');
  } finally {
    await svc.stop();
  }
});

test('kv: a list field keeps its order', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { meta: { a: 1 }, tags: ['x', 'y'] });
    assert.equal(put.status, 201);
    assert.equal(await count(svc.base, 'list'), 1, 'the same order matches');
    assert.equal(await count(svc.base, 'listother'), 0, 'a reversed list is another value');
  } finally {
    await svc.stop();
  }
});
