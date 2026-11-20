// Bounds were published in the entity schema and stopped there: an insert
// stored a name longer than max or a number below min, so the row a client
// could never send through the contract existed in the store. Both facades
// (kv and sql) now read the same bounds table in checkRecordFields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, name: string(max: 3), score: number(min: 1.5) }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(name: string, score: number) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const impl = [
  'export async function put(input, io) {',
  "  return { result: await io.insert('Item', { id: io.new(), name: input.name, score: Number(input.score) }) };",
  '}',
].join('\n');

async function put(body: Record<string, unknown>) {
  const svc = await startService(source, { impl: { put: impl } });
  try {
    const res = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await svc.stop();
  }
}

test('an insert above the string bound is 400, not a stored row', async () => {
  const res = await put({ name: 'abcdef', score: 2 });
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: name must be at most 3 characters/);
});

test('an insert below a real bound is 400 too', async () => {
  const res = await put({ name: 'abc', score: 1 });
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: score must be >= 1.5/);
});

test('a number in a string field is 400, not a row kv and sql read differently', async () => {
  const res = await put({ name: 42, score: 2 });
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: name must be a string/);
});

test('a value inside both bounds is stored', async () => {
  const res = await put({ name: 'abc', score: 2 });
  assert.equal(res.status, 201);
  assert.match(res.text, /"name":"abc"/);
});
