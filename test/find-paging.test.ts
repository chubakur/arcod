import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// A filtered page must stay a page: the cursor carries the last row's sort
// values, so the second request continues where the first stopped and the
// filter is applied to the whole set, not to the slice.

const spec = [
  'module paging @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type ItemId = uuid',
  'type Item = { id: ItemId, tag: string, seq: int }',
  '',
  'error Invalid',
  '',
  'service Paging : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(tag: string, seq: int) -> { id: ItemId } {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op page(tag: string, limit: int, cursor: string?) -> { items: list<Item>, next: string? } {',
  '      route: "POST /v1/page"',
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
    '  const record = { id: io.new(), tag: String(input.tag), seq: Number(input.seq) };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  page: [
    'export async function page(input, io) {',
    '  const options = {',
    '    where: { tag: String(input.tag) },',
    '    order: "seq asc",',
    '    limit: Number(input.limit) || 2,',
    '  };',
    '  if (input.cursor) options.cursor = String(input.cursor);',
    '  const found = await io.find("Item", options);',
    '  return { result: { items: found.items, next: found.next } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a filtered find pages by cursor without repeating a row', async () => {
  const svc = await startService(spec, { impl });
  try {
    for (const seq of [1, 2, 3]) await post(svc.base + '/v1/items', { tag: 'a', seq });
    for (const seq of [4, 5]) await post(svc.base + '/v1/items', { tag: 'b', seq });

    const first = await post(svc.base + '/v1/page', { tag: 'a', limit: 2 });
    assert.equal(first.status, 201);
    const page1 = await first.json();
    assert.equal(page1.items.length, 2, 'the page honours the limit');
    assert.ok(page1.next, 'more matching rows produce a cursor');
    assert.deepEqual(page1.items.map((item: any) => item.seq), [1, 2], 'the filter and order hold');

    const second = await post(svc.base + '/v1/page', { tag: 'a', limit: 2, cursor: page1.next });
    const page2 = await second.json();
    assert.equal(page2.items.length, 1, 'the tail of the filtered set');
    assert.deepEqual(page2.items.map((item: any) => item.seq), [3]);
    assert.equal(page2.next, null, 'the last page has no cursor');

    const ids = [...page1.items, ...page2.items].map((item: any) => item.id);
    assert.equal(new Set(ids).size, 3, 'no row is served twice');
  } finally {
    await svc.stop();
  }
});
