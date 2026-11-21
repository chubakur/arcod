import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// A declared field that is not optional cannot hold null. kv used to store the
// absence anyway, and a NOT NULL column failed inside the sql driver as a 500 -
// the same call answered two things. The column list already says which fields
// are optional, so the record check answers Invalid on every store.

const SPEC = [
  'module required @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  'type Row = {',
  '  id: uuid,',
  '  name: string,',
  '  note: string?',
  '}',
  'error Invalid',
  'error NotFound',
  'service Required : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '  effects { allow store.insert, store.update, store.find, uuid.new }',
  '  contract {',
  '    public op create(name: string) -> Row {',
  '      route: "POST /v1/rows"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '    public op blank(id: uuid) -> Row {',
  '      route: "PATCH /v1/rows/:id"',
  '      effects: store.update',
  '      errors: Invalid, NotFound',
  '      on error NotFound: id != null',
  '    }',
  '    public op note(id: uuid, note: string?) -> Row {',
  '      route: "PATCH /v1/rows/:id/note"',
  '      effects: store.update',
  '      errors: Invalid, NotFound',
  '      on error NotFound: id != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '}',
  '',
].join('\n');

const IMPL = {
  create: [
    'export async function create(input, io) {',
    "  const row = await io.insert('Row', { id: io.new(), name: String(input.name) });",
    '  return { result: row };',
    '}',
    '',
  ].join('\n'),
  blank: [
    'export async function blank(input, io) {',
    "  return { result: await io.update('Row', input.id, { name: null }) };",
    '}',
    '',
  ].join('\n'),
  note: [
    'export async function note(input, io) {',
    '  const patch = input.note == null ? { note: null } : { note: String(input.note) };',
    "  return { result: await io.update('Row', input.id, patch) };",
    '}',
    '',
  ].join('\n'),
};

const send = (url: string, method: string, body: unknown) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('a required field refuses null on insert and update, an optional one does not', async () => {
  const svc = await startService(SPEC, { impl: IMPL });
  try {
    const created = await send(svc.base + '/v1/rows', 'POST', { name: 'first' });
    assert.equal(created.status, 201);
    const row = await created.json();

    const blank = await send(svc.base + '/v1/rows/' + row.id, 'PATCH', {});
    assert.equal(blank.status, 400, 'clearing a required field is Invalid, not a stored null');
    const body = await blank.json();
    assert.match(String(body.message), /name is not nullable/);

    const still = await send(svc.base + '/v1/rows', 'GET', undefined);
    assert.equal(still.status, 404, 'the failed update changed nothing (no GET route is declared)');

    const note = await send(svc.base + '/v1/rows/' + row.id + '/note', 'PATCH', { note: 'hello' });
    assert.equal(note.status, 201, 'an optional field takes a value');
    const cleared = await send(svc.base + '/v1/rows/' + row.id + '/note', 'PATCH', { note: null });
    assert.equal(cleared.status, 201, 'an optional field may be cleared');
  } finally {
    await svc.stop();
  }
});

test('inserting a record without a required field is Invalid, not an absent cell', async () => {
  const impl = { ...IMPL, create: [
    'export async function create(input, io) {',
    "  const row = await io.insert('Row', { id: io.new() });",
    '  return { result: row };',
    '}',
    '',
  ].join('\n') };
  const svc = await startService(SPEC, { impl });
  try {
    const res = await send(svc.base + '/v1/rows', 'POST', { name: 'first' });
    assert.equal(res.status, 400, 'a required field omitted at insert is Invalid');
    assert.match(String((await res.json()).message), /insert Row: missing name/);
  } finally {
    await svc.stop();
  }
});
