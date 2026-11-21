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
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(at: datetime) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid, Conflict',
  '    }',
  '',
  '    public op find(at: datetime) -> { items: list<Item> } {',
  '      route: "POST /v1/find"',
  '      effects: store.find',
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

const findImpl = [
  'export async function find(input, io) {',
  "  const page = await io.find('Item', { where: { at: input.at } });",
  '  return { result: { items: page.items } };',
  '}',
].join('\n');

async function put(at: unknown) {
  const svc = await startService(source, { impl: { put: putImpl, find: findImpl } });
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

test('a filter spelled with another offset finds the row', async () => {
  const svc = await startService(source, { impl: { put: putImpl, find: findImpl } });
  try {
    const created = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T02:00:00+02:00' }),
    });
    assert.equal(created.status, 201);
    const res = await fetch(svc.base + '/v1/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2025-12-31T19:00:00-05:00' }),
    });
    assert.equal(res.status, 201);
    const page = await res.json();
    assert.equal(page.items.length, 1, 'the same instant is the same filter value');
    assert.equal(page.items[0].at, '2026-01-01T00:00:00Z');
  } finally {
    await svc.stop();
  }
});

test('a filter that is not an ISO datetime is a 400, not a silent empty page', async () => {
  const svc = await startService(source, { impl: { put: putImpl, find: findImpl } });
  try {
    const res = await fetch(svc.base + '/v1/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: 'yesterday' }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /where: at must be an ISO 8601 datetime/);
  } finally {
    await svc.stop();
  }
});


// The store in the spec above is kv. The sql facade must answer the same
// insert and the same filter: both run against the in-memory driver, and a
// canonical value is what makes the two text representations agree.
const sqlSource = source.split('arcod.std.kv').join('arcod.std.sql').split('uses store: kv').join('uses store: sql');

test('the sql driver stores and filters the same instant as kv', async () => {
  const svc = await startService(sqlSource, { impl: { put: putImpl, find: findImpl } });
  try {
    const created = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T02:00:00+02:00' }),
    });
    assert.equal(created.status, 201);
    assert.equal(JSON.parse(await created.text()).at, '2026-01-01T00:00:00Z');
    const res = await fetch(svc.base + '/v1/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2025-12-31T19:00:00-05:00' }),
    });
    assert.equal(res.status, 201);
    const page = await res.json();
    assert.equal(page.items.length, 1);
  } finally {
    await svc.stop();
  }
});


// A unique rule is a promise about the stored value. Two spellings of one
// instant must therefore claim the same key, or kv would store two rows the
// contract says cannot exist (mysql's UNIQUE column already refused).
const uniqueSource = source.replace("  effects {\n", "  rules {\n    unique Item.at\n  }\n\n  effects {\n");

test('a unique datetime claims one key for two offsets', async () => {
  const svc = await startService(uniqueSource, { impl: { put: putImpl, find: findImpl } });
  try {
    const first = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T02:00:00+02:00' }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T00:00:00Z' }),
    });
    assert.equal(second.status, 409, 'the same instant is the same unique value');
  } finally {
    await svc.stop();
  }
});


// The same canonicalization applies inside an "in" list: a client may write
// each element in its own offset, and the list must still match the one row.
const inImpl = [
  'export async function inside(input, io) {',
  "  const page = await io.find('Item', { where: { at: { in: [input.at, '2030-01-01T00:00:00Z'] } } });",
  '  return { result: { items: page.items } };',
  '}',
].join(String.fromCharCode(10));

const inSource = source
  .replace("    public op find", "    public op inside(at: datetime) -> { items: list<Item> } {" + String.fromCharCode(10) + "      route: \"POST /v1/inside\"" + String.fromCharCode(10) + "      effects: store.find" + String.fromCharCode(10) + "      errors: Invalid" + String.fromCharCode(10) + "    }" + String.fromCharCode(10) + "" + String.fromCharCode(10) + "    public op find");

test('an "in" list canonicalizes each element', async () => {
  const svc = await startService(inSource, { impl: { put: putImpl, find: findImpl, inside: inImpl } });
  try {
    const created = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T02:00:00+02:00' }),
    });
    assert.equal(created.status, 201);
    const res = await fetch(svc.base + '/v1/inside', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2025-12-31T19:00:00-05:00' }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).items.length, 1);
  } finally {
    await svc.stop();
  }
});


// The update path checks a patch, and the same canonicalization has to reach
// what is stored: a patch written in another offset must not leave the row
// with a second spelling of the same instant.
test('an update patch is stored canonically too', async () => {
  const src = source
    .replace("    public op find", "    public op touch(id: uuid, at: datetime) -> Item {" + String.fromCharCode(10) + "      route: \"POST /v1/touch\"" + String.fromCharCode(10) + "      effects: store.update" + String.fromCharCode(10) + "      errors: Invalid, NotFound" + String.fromCharCode(10) + "    }" + String.fromCharCode(10) + "" + String.fromCharCode(10) + "    public op find");
  const touchImpl = [
    'export async function touch(input, io) {',
    '  return { result: await io.update("Item", String(input.id), { at: input.at }) };',
    '}',
  ].join(String.fromCharCode(10));
  const svc = await startService(src, { impl: { put: putImpl, find: findImpl, touch: touchImpl } });
  try {
    const created = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '2026-01-01T00:00:00Z' }),
    });
    assert.equal(created.status, 201);
    const id = JSON.parse(await created.text()).id;
    const res = await fetch(svc.base + '/v1/touch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, at: '2026-06-01T05:00:00+05:00' }),
    });
    assert.equal(res.status, 201);
    assert.equal(JSON.parse(await res.text()).at, '2026-06-01T00:00:00Z');
  } finally {
    await svc.stop();
  }
});

