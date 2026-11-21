// A bool column holds 1/0. kv compared String(true) = "true" while sql cast
// the TINYINT to "1", so the same contains query found different rows on the
// two drivers. The kv matcher now searches the text the column holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, flag: bool }',
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
  '    public op put(flag: bool) -> { id: uuid } {',
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
    '  const record = { id: io.new(), flag: Boolean(input.flag) };',
    '  await io.insert("Item", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  scan: [
    'export async function scan(input, io) {',
    '  const mode = String(input.mode || "one");',
    '  const needle = mode === "one" ? "1" : mode === "zero" ? "0" : "true";',
    '  const page = await io.find("Item", { where: { flag: { contains: needle } } });',
    '  return { result: { items: page.items } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: contains on a bool searches the 1/0 text a column holds', async () => {
  const svc = await startService(spec, { impl });
  try {
    const put = await post(svc.base + '/v1/items', { flag: true });
    assert.equal(put.status, 201);

    const one = await post(svc.base + '/v1/scan', { mode: 'one' });
    assert.equal(one.status, 201);
    assert.equal((await one.json()).items.length, 1, 'true is stored as 1');

    const zero = await post(svc.base + '/v1/scan', { mode: 'zero' });
    assert.equal((await zero.json()).items.length, 0);

    const word = await post(svc.base + '/v1/scan', { mode: 'word' });
    assert.equal((await word.json()).items.length, 0, 'the word true is not the column text');
  } finally {
    await svc.stop();
  }
});
