// io.insert refused a record without an id with a bare 400 Invalid: the
// caller saw no field, and check was silent because the record type looks
// legal. The message names the entity and the field now, and W037 points at
// the insert that can never work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { startService } from './harness.ts';

const SPEC = [
  'module rooms @0.1.0 {',
  '}',
  '',
  'type Room = { name: string, seats: int }',
  'type Note = { id: uuid, text: string }',
  '',
  'service Rooms : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op add(name: string, seats: int) -> Room {',
    '      route: "POST /v1/rooms"',
    '      errors: Invalid',
  '    }',
  '',
  '    public op note(text: string) -> Note {',
    '      route: "POST /v1/notes"',
  '      effects: store.insert, uuid.new',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv")',
  '  bind uuid -> local',
  '  deploy docker',
  '}',
].join('\n');

const IMPL = {
  add: "export async function add(input, io) { return { result: await io.insert('Room', { name: input.name, seats: input.seats }) }; }",
  note: "export async function note(input, io) { return { result: await io.insert('Note', { id: io.new(), text: input.text }) }; }",
};

test('check names the type that io.insert cannot key', () => {
  const mod = parse(SPEC, 'main.arc');
  const found = check(mod, { impl: IMPL }).filter((item) => item.code === 'W037');
  assert.deepEqual(found.map((item) => [item.severity, item.file, item.path, item.message]), [
    ['warning', 'impl/add.mjs', 'impl.add', 'insert Room: the type has no id field'],
  ]);
});

test('an insert without an id answers 400 with the entity and the field', async () => {
  const service = await startService(SPEC, { impl: IMPL });
  try {
    const response = await fetch(service.base + '/v1/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'main', seats: 4 }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; message: string };
    assert.equal(body.error, 'Invalid');
    assert.equal(body.message, 'insert Room: missing id');
  } finally {
    await service.stop();
  }
});

test('an insert with an id is unchanged', async () => {
  const service = await startService(SPEC, { impl: IMPL });
  try {
    const response = await fetch(service.base + '/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { id: string; text: string };
    assert.equal(typeof body.id, 'string');
    assert.equal(body.text, 'hello');
  } finally {
    await service.stop();
  }
});
