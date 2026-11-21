// A datetime is an instant in a scalar column and inside a typed container:
// list<datetime> and map<datetime> are JSON text, so both drivers kept the
// spelling the caller wrote ("+03:00", a space) while a scalar column read
// back canonical. The emitter now records how many list/map wrappers sit above
// the instant (STORES[entity].instants) and checkRecordFields applies the same
// canonical spelling at every leaf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

function spec(store: 'kv' | 'sql'): string {
  return [
    'module probe @0.1.0 {}',
    '',
    'use capability arcod.std.' + store + ' @1',
    'use capability arcod.std.ids @1',
    '',
    'type Event = {',
    '  id: uuid,',
    '  at: datetime,',
    '  marks: list<datetime>,',
    '  tags: map<string, datetime>,',
    '  grid: list<list<datetime>>',
    '}',
    '',
    'error Invalid',
    '',
    'service Probe : http {',
    '  uses store: ' + store,
    '  uses uuid: ids',
    '',
    '  effects {',
    '    allow store.insert, store.fetch, uuid.new',
    '  }',
    '',
    '  contract {',
    '    public op put(at: datetime, marks: list<datetime>, tags: map<string, datetime>, grid: list<list<datetime>>) -> Event {',
    '      route: "POST /v1/events"',
    '      effects: store.insert, uuid.new',
    '      errors: Invalid',
    '    }',
    '',
    '    public op get(id: uuid) -> Event {',
    '      route: "GET /v1/events/:id"',
    '      effects: store.fetch',
    '      errors: Invalid, NotFound',
    '    }',
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
}

const impl: Record<string, string> = {
  put: [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Event', { id: io.new(), at: input.at, marks: input.marks, tags: input.tags, grid: input.grid }) };",
    '}',
  ].join(String.fromCharCode(10)),
  get: [
    'export async function get(input, io) {',
    "  return { result: await io.fetch('Event', input.id) };",
    '}',
  ].join(String.fromCharCode(10)),
};

async function roundtrip(store: 'kv' | 'sql', payload: Record<string, unknown>) {
  const svc = await startService(spec(store), { impl });
  try {
    const res = await fetch(svc.base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const created = res.status === 201 ? JSON.parse(text) : null;
    let stored: Record<string, unknown> | null = null;
    if (created) {
      const got = await fetch(svc.base + '/v1/events/' + created.id);
      stored = got.status === 200 ? await got.json() : null;
    }
    return { status: res.status, text, created, stored };
  } finally {
    await svc.stop();
  }
}

for (const store of ['kv', 'sql'] as const) {
  test(store + ': a list of instants is stored in the canonical spelling', async () => {
    const res = await roundtrip(store, {
      at: '2026-01-01T12:00:00+03:00',
      marks: ['2026-01-01T12:00:00+03:00', '2026-01-01T09:00:00Z'],
      tags: { first: '2026-01-01T12:00:00+03:00' },
      grid: [['2026-01-01T09:00:00.000Z']],
    });
    assert.equal(res.status, 201, res.text);
    const expected = '2026-01-01T09:00:00Z';
    assert.equal(res.created?.at, expected, 'the scalar column is canonical');
    assert.deepEqual(res.created?.marks, [expected, expected], 'each element is canonical');
    assert.deepEqual(res.created?.tags, { first: expected }, 'a map value is canonical');
    assert.deepEqual(res.created?.grid, [[expected]], 'a nested list is canonical');
    // The row read back from the store, not only echoed by insert.
    assert.deepEqual(res.stored?.marks, [expected, expected], 'read back canonical');
    assert.deepEqual(res.stored?.tags, { first: expected }, 'map read back canonical');
    assert.deepEqual(res.stored?.grid, [[expected]], 'nested list read back canonical');
  });

  test(store + ': a value that is not an instant inside a container is Invalid', async () => {
    const res = await roundtrip(store, {
      at: '2026-01-01T09:00:00Z',
      marks: ['2026-01-01T09:00:00Z', 'yesterday'],
      tags: {},
      grid: [],
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /marks must hold an ISO 8601 datetime/);
  });

  test(store + ': a container that is not a list or map of instants is Invalid', async () => {
    const res = await roundtrip(store, {
      at: '2026-01-01T09:00:00Z',
      marks: 'not a list',
      tags: {},
      grid: [],
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /marks must be a list or map of datetime/);
  });

  test(store + ': a null element stays null', async () => {
    const res = await roundtrip(store, {
      at: '2026-01-01T09:00:00Z',
      marks: [null, '2026-01-01T12:00:00+03:00'],
      tags: {},
      grid: [],
    });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.created?.marks, [null, '2026-01-01T09:00:00Z']);
  });
}
