// A boolean and a datetime declared by an entity were believed by both
// facades. kv kept whatever the body wrote ("false", 42, "yesterday"), while
// sql read truthiness (so the string "false" became TRUE) or handed the
// garbage to the driver, which answered 500. The same insert therefore had a
// different outcome per driver and could store a row the contract forbids.
// checkRecordFields now names the field and the shape it expects: bool takes
// a boolean, datetime an ISO 8601 instant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, done: bool, at: datetime }',
  '',
  'error Invalid',
  'error NotFound',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, store.update, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(done: bool, at: datetime) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '    public op touch(id: uuid) -> Item {',
  '      route: "POST /v1/items/touch"',
  '      effects: store.update, store.find',
  '      errors: Invalid, NotFound',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const putImpl = [
  'export async function put(input, io) {',
  '  return { result: await io.insert(\'Item\', { id: io.new(), done: input.done, at: input.at }) };',
  '}',
].join('\n');

const touchImpl = [
  'export async function touch(input, io) {',
  '  return { result: await io.update(\'Item\', String(input.id), { at: \'yesterday\' }) };',
  '}',
].join('\n');

async function withService(
  impl: Record<string, string>,
  run: (base: string) => Promise<void>,
) {
  const svc = await startService(source, { impl });
  try {
    await run(svc.base);
  } finally {
    await svc.stop();
  }
}

async function put(done: unknown, at: unknown) {
  let out = { status: 0, text: '' };
  await withService({ put: putImpl, touch: touchImpl }, async (base) => {
    const res = await fetch(base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done, at }),
    });
    out = { status: res.status, text: await res.text() };
  });
  return out;
}

test('a boolean field refuses a string the driver would read as TRUE', async () => {
  const res = await put('false', '2026-01-01T00:00:00Z');
  assert.equal(res.status, 400);
  // The boundary names the parameter without the store's insert prefix: the
  // JSON type is wrong before any statement is written.
  assert.equal(JSON.parse(res.text).message, 'done must be a boolean');
});

test('a boolean field refuses a number', async () => {
  const res = await put(0, '2026-01-01T00:00:00Z');
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.text).message, 'done must be a boolean');
});

test('a datetime field refuses a word kv used to keep', async () => {
  const res = await put(true, 'yesterday');
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: at must be an ISO 8601 datetime/);
});

test('a datetime field refuses a bare number the driver choked on', async () => {
  const res = await put(true, 1735689600000);
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: at must be an ISO 8601 datetime/);
});

test('an update patch is checked the same way as an insert', async () => {
  const created = await put(true, '2026-01-01T00:00:00Z');
  assert.equal(created.status, 201);
  const id = JSON.parse(created.text).id as string;
  await withService({ put: putImpl, touch: touchImpl }, async (base) => {
    const res = await fetch(base + '/v1/items/touch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /update Item: at must be an ISO 8601 datetime/);
  });
});

test('a boolean and an ISO instant are stored and read back unchanged', async () => {
  const res = await put(false, '2026-02-03T04:05:06.789Z');
  assert.equal(res.status, 201);
  const row = JSON.parse(res.text);
  assert.equal(row.done, false);
  assert.equal(row.at, '2026-02-03T04:05:06.789Z');
});
