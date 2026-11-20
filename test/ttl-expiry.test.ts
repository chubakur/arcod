import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// The docs now say a kv record — entity row included — dies when its ttl runs
// out, and that the default is 999 s. The emitter tests pin the value that
// reaches the store; this one waits for a real expiry, so a driver that
// ignores the ttl cannot pass by writing the right number into CONFIG.

const spec = (ttl: string) => [
  'module ledger @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type EntryId = uuid',
  'type Entry = { id: EntryId, amount: int }',
  '',
  'error NotFound',
  '',
  'service Ledger : http {',
  '  uses store: kv(ttl: ' + ttl + ')',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.fetch, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op add(amount: int) -> { id: string } {',
  '      route: "POST /v1/add"',
  '      effects: store.insert, uuid.new',
  '      errors: NotFound',
  '      post: result != null',
  '    }',
  '',
  '    public op get(id: string) -> Entry {',
  '      route: "GET /v1/get/:id"',
  '      effects: store.fetch',
  '      errors: NotFound',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const impl = {
  add: [
    'export async function add(input, io) {',
    '  const id = io.new();',
    '  await io.insert("Entry", { id, amount: Number(input.amount) });',
    '  return { result: { id } };',
    '}',
  ].join(String.fromCharCode(10)),
  get: [
    'export async function get(input, io) {',
    '  const entry = await io.fetch("Entry", input.id);',
    '  if (!entry) return { error: "NotFound" };',
    '  return { result: entry };',
    '}',
  ].join(String.fromCharCode(10)),
};

test('a kv entity row disappears after its ttl', async () => {
  const svc = await startService(spec('2s'), { impl });
  try {
    const created = await fetch(svc.base + '/v1/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 7 }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const fresh = await fetch(svc.base + '/v1/get/' + id);
    assert.equal(fresh.status, 200, 'the row is there right after the insert');
    assert.equal((await fresh.json()).amount, 7);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const gone = await fetch(svc.base + '/v1/get/' + id);
    assert.equal(gone.status, 404, 'the storage ttl expires the entity row');
  } finally {
    await svc.stop();
  }
});
