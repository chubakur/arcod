// An `int` field is whole numbers. Its bound arguments are optional, so the
// column check ran only for a bounded int: `io.insert('Box', { qty: 1.5 })`
// stayed 1.5 on kv while a BIGINT column truncated it (or the driver refused
// it), and one insert read two ways. The column list knows the base type, so
// checkRecordFields rejects a fraction with or without a declared bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Box = { id: uuid, qty: int, weight: int(min: 1, max: 10) }',
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
  '    public op put(qty: int, weight: int) -> Box {',
  '      route: "POST /v1/boxes"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const impl = [
  'export async function put(input, io) {',
  "  return { result: await io.insert('Box', { id: io.new(), qty: input.qty, weight: input.weight }) };",
  '}',
].join('\n');

async function put(qty: unknown, weight: unknown) {
  const svc = await startService(source, { impl: { put: impl } });
  try {
    const res = await fetch(svc.base + '/v1/boxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty, weight }),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await svc.stop();
  }
}

test('an unbounded int refuses a fraction kv would have kept', async () => {
  const res = await put(1.5, 2);
  assert.equal(res.status, 400);
  // The boundary refuses it by name: a typed parameter no longer reaches the
  // store's own message (DECISIONS, 2026-11-26).
  assert.equal(JSON.parse(res.text).message, 'qty must be an integer');
});

test('a bounded int refuses a fraction with the same message', async () => {
  const res = await put(2, 1.5);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.text).message, 'weight must be an integer');
});

test('whole numbers in both fields are stored', async () => {
  const res = await put(2, 3);
  assert.equal(res.status, 201);
  assert.match(res.text, /"qty":2/);
});

test('a JSON string is not a number: the boundary refuses it by name', async () => {
  const res = await put('3', 2);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.text).message, 'qty must be an integer');
});
