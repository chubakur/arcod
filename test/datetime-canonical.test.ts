// A datetime field is an instant, and both drivers must store the same one.
// kv kept the body text verbatim while mysql kept DATETIME(3): "+02:00" stayed
// an offset on kv and became UTC on sql, "2026-02-30" rolled into March, and a
// microsecond fraction lost two digits only on sql. checkRecordFields now
// canonicalizes the value once (UTC, milliseconds, T, Z) and refuses a
// fraction the column cannot hold instead of cutting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const source = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, at: datetime }',
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
  '    public op put(at: datetime) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const putImpl = [
  'export async function put(input, io) {',
  "  return { result: await io.insert('Item', { id: io.new(), at: input.at }) };",
  '}',
].join('\n');

async function put(at: unknown) {
  const svc = await startService(source, { impl: { put: putImpl } });
  let out = { status: 0, text: '' };
  try {
    const res = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at }),
    });
    out = { status: res.status, text: await res.text() };
  } finally {
    await svc.stop();
  }
  return out;
}

test('an offset is converted to UTC, not kept as written', async () => {
  const res = await put('2026-01-01T02:00:00+02:00');
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.text).at, '2026-01-01T00:00:00Z');
});

test('a missing zone means UTC and a space separator is accepted', async () => {
  const res = await put('2026-01-01 12:34:56');
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.text).at, '2026-01-01T12:34:56Z');
});

test('a bare date is midnight UTC, the same day', async () => {
  const res = await put('2026-01-01');
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.text).at, '2026-01-01T00:00:00Z');
});

test('milliseconds inside DATETIME(3) survive', async () => {
  const res = await put('2026-02-03T04:05:06.789Z');
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.text).at, '2026-02-03T04:05:06.789Z');
});

test('a microsecond fraction is refused, not cut to milliseconds', async () => {
  const res = await put('2026-02-03T04:05:06.123456Z');
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: at must be an ISO 8601 datetime/);
});

test('a day the calendar does not have is refused instead of rolled over', async () => {
  const res = await put('2026-02-30T10:00:00Z');
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: at must be an ISO 8601 datetime/);
});

test('a time that does not exist is refused', async () => {
  const res = await put('2026-02-03T24:00:00Z');
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: at must be an ISO 8601 datetime/);
});
