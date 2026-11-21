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
  'type Item = { id: uuid, name: string(max: 3), score: number(min: 1.5), doc: bytes? }',
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

test('a numeric string an impl writes is 400', async () => {
  const badImpl = [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Item', { id: io.new(), name: String(input.name), score: '2' }) };",
    '}',
  ].join(String.fromCharCode(10));
  const svc = await startService(source, { impl: { put: badImpl } });
  try {
    const res = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'abc', score: 2 }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /insert Item: score must be a number/);
  } finally {
    await svc.stop();
  }
});

test('a number in a bytes field is 400: kv kept the number, sql the text', async () => {
  const badImpl = [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Item', { id: io.new(), name: String(input.name), score: Number(input.score), doc: 42 }) };",
    '}',
  ].join(String.fromCharCode(10));
  const svc = await startService(source, { impl: { put: badImpl } });
  try {
    const res = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'abc', score: 2 }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /insert Item: doc must be a string/);
  } finally {
    await svc.stop();
  }
});

test('a value inside both bounds is stored', async () => {
  const res = await put({ name: 'abc', score: 2 });
  assert.equal(res.status, 201);
  assert.match(res.text, /"name":"abc"/);
});

// A size unit is a bound the schema already publishes: OpenAPI reads
// `bytes(max: 2kb)` as maxLength 2048. The runtime resolver used to skip a
// non-literal argument, so the field was unbounded where the contract said 2kb.
const kbSource = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Note = { id: uuid, body: bytes(max: 2kb) }',
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
  '    public op put(body: bytes) -> Note {',
  '      route: "POST /v1/notes"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const kbImpl = 'export async function put(input, io) { return { result: await io.insert("Note", { id: io.new(), body: String(input.body) }) }; }';

test('a bytes bound with a size unit is enforced on insert', async () => {
  const svc = await startService(kbSource, { impl: { put: kbImpl } });
  try {
    const small = await fetch(svc.base + '/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(10) }),
    });
    assert.equal(small.status, 201, 'a value inside 2kb is stored');
    const big = await fetch(svc.base + '/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(2049) }),
    });
    assert.equal(big.status, 400, 'a value past 2kb is Invalid');
    assert.match(await big.text(), /body must be at most 2048 characters/);
  } finally {
    await svc.stop();
  }
});

