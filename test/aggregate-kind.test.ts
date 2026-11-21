// A total needs a number. The kv aggregate folded rows and only failed on a
// value that was not a number, so an empty table answered 0 for a list field,
// and a text column holding "5" was summed as 5. Sql either did the same or
// failed inside the driver. The declared type now decides before a row is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Entry = { id: uuid, amount: int, code: string, tags: list<string> }',
  '',
  'error Invalid',
  '',
  'service Ledger : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.aggregate, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op seed(amount: int, code: string) -> { id: uuid } {',
  '      route: "POST /v1/seed"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op total(field: string) -> { sum: float } {',
  '      route: "POST /v1/total"',
  '      effects: store.aggregate',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  seed: [
    'export async function seed(input, io) {',
    '  const record = { id: io.new(), amount: Number(input.amount), code: String(input.code), tags: ["a", "b"] };',
    '  await io.insert("Entry", record);',
    '  return { result: { id: record.id } };',
    '}',
  ].join(String.fromCharCode(10)),
  total: [
    'export async function total(input, io) {',
    '  const sum = await io.aggregate("Entry", { field: String(input.field), op: "sum" });',
    '  return { result: { sum } };',
    '}',
  ].join(String.fromCharCode(10)),
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('kv: aggregate names a non-numeric field even when no row was read', async () => {
  const svc = await startService(spec, { impl });
  try {
    for (const field of ['tags', 'code']) {
      const res = await post(svc.base + '/v1/total', { field });
      assert.equal(res.status, 400, field + ' is not numeric');
      assert.match(String((await res.json()).message), new RegExp('aggregate: field "' + field + '" is not numeric'));
    }
    const amount = await post(svc.base + '/v1/total', { field: 'amount' });
    assert.equal(amount.status, 201, 'a numeric field on an empty table answers the empty sum');
    assert.equal((await amount.json()).sum, 0);
  } finally {
    await svc.stop();
  }
});

test('kv: a numeric-looking text value is not summed', async () => {
  const svc = await startService(spec, { impl });
  try {
    const seed = await post(svc.base + '/v1/seed', { amount: 7, code: '5' });
    assert.equal(seed.status, 201);

    const code = await post(svc.base + '/v1/total', { field: 'code' });
    assert.equal(code.status, 400, 'a text field is not a total, even when its values look numeric');

    const amount = await post(svc.base + '/v1/total', { field: 'amount' });
    assert.equal(amount.status, 201);
    assert.equal((await amount.json()).sum, 7);
  } finally {
    await svc.stop();
  }
});
