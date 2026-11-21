// A cursor carries the sort values of the row it stopped at, and every store
// spells those values its own way: kv sorts a moment as an epoch number, MySQL
// prints '2026-01-01 00:00:00.000', Postgres leaves the space out. Feeding one
// store's cursor to another used to pass the shape check and compare the wrong
// spellings, so the page was silently wrong. The cursor now names the store
// that minted it, a foreign tag is 400, and a tagless cursor from an older
// build still continues (the check only refuses a tag it can see).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function sourceOf(store: 'kv' | 'sql') {
  const uses = store === 'kv' ? 'kv' : 'sql(ttl: 604800s)';
  const bind = store === 'kv' ? 'redis(host: "kv", port: 6379)' : 'mysql';
  return [
    'module cursorstore @0.1.0 {}',
    'use capability arcod.std.' + (store === 'kv' ? 'kv' : 'sql') + ' @1',
    'use capability arcod.std.ids @1',
    'type ItemId = uuid',
    'type Item = { id: ItemId, tag: string, seq: int }',
    'error Invalid',
    'service CursorStore : http {',
    '  uses store: ' + uses,
    '  uses uuid: ids',
    '  effects {',
    '    allow store.insert, store.find, uuid.new',
    '  }',
    '  contract {',
    '    public op put(seq: int) -> { id: ItemId } {',
    '      route: "POST /v1/items"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '    public op page(cursor: string?) -> { items: list<Item>, next: string? } {',
    '      route: "POST /v1/page"',
    '      effects: store.find',
    '      errors: Invalid',
    '    }',
    '  }',
    '}',
    'environment dev {',
    '  bind store -> ' + bind,
    '  bind uuid -> local',
    '}',
    '',
  ].join('\n');
}

const impl = {
  put: [
    'export async function put(input, io) {',
    "  const record = { id: io.new(), tag: 'a', seq: Number(input.seq) };",
    "  await io.insert('Item', record);",
    '  return { result: { id: record.id } };',
    '}',
    '',
  ].join('\n'),
  page: [
    'export async function page(input, io) {',
    "  const options = { order: 'seq asc', limit: 1 };",
    "  if (input.cursor) options.cursor = String(input.cursor);",
    "  const found = await io.find('Item', options);",
    '  return { result: { items: found.items, next: found.next } };',
    '}',
    '',
  ].join('\n'),
};

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const payload = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

async function firstPage(store: 'kv' | 'sql') {
  const svc = await startService(sourceOf(store), { impl });
  await post(svc.base, '/v1/items', { seq: 1 });
  await post(svc.base, '/v1/items', { seq: 2 });
  const res = await post(svc.base, '/v1/page', {});
  assert.equal(res.status, 201);
  const page = await res.json();
  assert.ok(page.next, 'a second item means a cursor');
  return { svc, page };
}

// The sql memory driver (arcod test / SQL_DRIVER=memory) is the same kv store,
// so its cursors are kv-spelled and tagged kv: a real mysql cursor is refused
// there for the same reason a kv one is refused live -- the values differ.
test('the sql memory driver mints kv-tagged cursors and refuses a mysql one', async () => {
  const svc = await startService(sourceOf('sql'), { impl });
  try {
    await post(svc.base, '/v1/items', { seq: 1 });
    await post(svc.base, '/v1/items', { seq: 2 });
    const res = await post(svc.base, '/v1/page', {});
    assert.equal(res.status, 201);
    const page = await res.json();
    assert.equal(payload(page.next).s, 'kv', 'the memory driver is the kv store');
    const foreign = Buffer.from(JSON.stringify({ v: [1], id: 'x', s: 'mysql' })).toString('base64url');
    const bad = await post(svc.base, '/v1/page', { cursor: foreign });
    assert.equal(bad.status, 400, 'a live mysql cursor is refused by the memory driver');
    assert.match(String((await bad.json()).message), /issued by the mysql store/);
  } finally {
    await svc.stop();
  }
});

test('kv names its cursors and refuses another store\'s', async () => {
  const { svc, page } = await firstPage('kv');
  try {
    assert.equal(payload(page.next).s, 'kv', 'the cursor says which store minted it');
    const foreign = Buffer.from(JSON.stringify({ v: [1], id: 'x', s: 'mysql' })).toString('base64url');
    const bad = await post(svc.base, '/v1/page', { cursor: foreign });
    assert.equal(bad.status, 400, 'a mysql cursor cannot continue a kv page');
    assert.match(String((await bad.json()).message), /issued by the mysql store/);
    const stale = payload(page.next);
    delete stale.s;
    const legacy = await post(svc.base, '/v1/page', { cursor: Buffer.from(JSON.stringify(stale)).toString('base64url') });
    assert.equal(legacy.status, 201, 'a cursor minted before the tag still continues');
    const second = await legacy.json();
    assert.deepEqual(second.items.map((item: any) => item.seq), [2], 'the tagless cursor still points at the right row');
  } finally {
    await svc.stop();
  }
});
