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

// One emitter slip turned every kv aggregate into a 500: the facade read
// meta.columns while the kv entity meta carried only prefix/uniqueGroups/
// defaults. A regex on the emitted text would not have noticed, so walk the
// field names the facade actually dereferences against the STORES table.
test('the kv facade only reads meta fields the STORES table carries', async () => {
  const { emitService } = await import('../src/emit/service.ts');
  const { parse } = await import('../src/parser.ts');
  const source = emitService(parse(spec, 'main.arc'), { impl });
  const head = 'const STORES = ';
  const start = source.indexOf(head);
  assert.notEqual(start, -1, 'the service carries a STORES table');
  const end = source.indexOf(String.fromCharCode(10) + '};', start);
  assert.notEqual(end, -1, 'the STORES table is a top-level object');
  const stores = JSON.parse(source.slice(start + head.length, end + 2));
  const fields = [...new Set(Array.from(source.matchAll(/meta\.([A-Za-z_][A-Za-z0-9_]*)/g), (match) => match[1]))];
  assert.ok(fields.length > 0, 'the facade reads the entity meta');
  for (const [entity, meta] of Object.entries(stores as Record<string, Record<string, unknown>>)) {
    for (const field of fields) {
      assert.ok(Object.hasOwn(meta, field), entity + ' meta lacks ' + field);
    }
  }
});

// min and max take the same one-pass path and were advertised in the Invalid
// message without a single test: an extreme over an empty set must be null,
// not 0 or the seed default.
const specWithExtremes = (() => {
  const lines = spec.split(String.fromCharCode(10));
  const close = lines.lastIndexOf('  }');
  lines.splice(
    close,
    0,
    '    public op extremes(kind: string?) -> { min: int, max: int } {',
    '      route: "GET /v1/extremes"',
    '      effects: store.aggregate',
    '      errors: Invalid',
    '      post: result != null',
    '    }',
    '',
  );
  return lines.join(String.fromCharCode(10));
})();

const extremesImpl = [
  'export async function extremes(input, io) {',
  '  const where = input.kind ? { kind: String(input.kind) } : null;',
  '  const min = await io.aggregate("Entry", { field: "amount", op: "min", where });',
  '  const max = await io.aggregate("Entry", { field: "amount", op: "max", where });',
  '  return { result: { min, max } };',
  '}',
].join(String.fromCharCode(10));

test('kv: min and max pick the extremes and answer null on an empty set', async () => {
   const svc = await startService(specWithExtremes, { impl: { ...impl, extremes: extremesImpl } });
  try {
    const seeded = await fetch(svc.base + '/v1/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 4, kind: 'a' }),
    });
    assert.equal(seeded.status, 201);

    const top = await (await fetch(svc.base + '/v1/extremes')).json();
    assert.equal(top.min, 1);
    assert.equal(top.max, 4);

    const empty = await (await fetch(svc.base + '/v1/extremes?kind=b')).json();
    assert.equal(empty.min, null);
    assert.equal(empty.max, null);
  } finally {
    await svc.stop();
  }
});
