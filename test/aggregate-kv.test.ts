import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// The emitted-text assertions in aggregate.test.ts prove the kv facade exists;
// this runs it against the kv driver. Entities live as records under the
// table prefix, so the same spec must answer the same numbers as sql: a
// report that scans the wrong prefix or drops `where` would pass a regex and
// still be wrong.

const spec = [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type EntryId = uuid',
  'type Entry = { id: EntryId, amount: int, kind: string }',
  '',
  'error Invalid',
  '',
  'service Ledger : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.aggregate, store.count, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op seed(n: int, kind: string) -> { n: int } {',
  '      route: "POST /v1/seed"',
  '      effects: store.insert',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op total(kind: string?) -> { sum: int, avg: float, count: int } {',
  '      route: "GET /v1/total"',
  '      effects: store.aggregate, store.count',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op broken() -> { sum: int } {',
  '      route: "GET /v1/broken"',
  '      effects: store.aggregate',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  seed: [
    'export async function seed(input, io) {',
    '  const n = Number(input.n);',
    '  const kind = String(input.kind || "a");',
    '  for (let index = 1; index <= n; index += 1) {',
    '    await io.insert("Entry", { id: io.new(), amount: index, kind });',
    '  }',
    '  return { result: { n } };',
    '}',
  ].join(String.fromCharCode(10)),
  total: [
    'export async function total(input, io) {',
    '  const where = input.kind ? { kind: String(input.kind) } : null;',
    '  const sum = await io.aggregate("Entry", { field: "amount", op: "sum", where });',
    '  const avg = await io.aggregate("Entry", { field: "amount", op: "avg", where });',
    '  const count = await io.count("Entry", { where });',
    '  return { result: { sum, avg, count } };',
    '}',
  ].join(String.fromCharCode(10)),
  broken: [
    'export async function broken(input, io) {',
    '  const sum = await io.aggregate("Entry", { field: "amount", op: "median" });',
    '  return { result: { sum } };',
    '}',
  ].join(String.fromCharCode(10)),
};

test('kv: aggregate sums stored records and honours the where filter', async () => {
  const svc = await startService(spec, { impl });
  try {
    const seeded = await fetch(svc.base + '/v1/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 5, kind: 'a' }),
    });
    assert.equal(seeded.status, 201);

    const total = await (await fetch(svc.base + '/v1/total')).json();
    assert.equal(total.count, 5, JSON.stringify(total));
    assert.equal(total.sum, 15);
    assert.equal(total.avg, 3);

    const filtered = await (await fetch(svc.base + '/v1/total?kind=b')).json();
    assert.equal(filtered.count, 0);
    assert.equal(filtered.sum, 0, 'sum of nothing is 0 on kv too');
    assert.equal(filtered.avg, null, 'avg of nothing is null on kv too');

    const broken = await fetch(svc.base + '/v1/broken');
    assert.equal(broken.status, 400);
    assert.match((await broken.json()).message, /unknown op .median./);
  } finally {
    await svc.stop();
  }
});
