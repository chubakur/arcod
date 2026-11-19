// A `where` operator the store does not know used to be dropped:
// `{ nextAt: { before: now } }` returned every row and looked like a filter.
// The runtime answers Invalid with the operator name, and W038 finds the
// literal before the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { startService } from './harness.ts';

const SPEC = [
  'module rooms @0.1.0 {',
  '}',
  '',
  'type Room = { id: uuid, name: string, seats: int }',
  '',
  'service Rooms : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.find, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op add(name: string, seats: int) -> Room {',
  '      route: "POST /v1/rooms"',
  '      effects: store.insert, uuid.new',
  '    }',
  '',
  '    public op bad() -> list<Room> {',
  '      route: "GET /v1/rooms/bad"',
  '      effects: store.find',
  '      errors: Invalid',
  '    }',
  '',
  '    public op atLeast(n: int) -> list<Room> {',
  '      route: "GET /v1/rooms/filter"',
  '      effects: store.find',
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

const BAD = "export async function bad(input, io) { const page = await io.find('Room', { where: { name: { nope: 1 } } }); return { result: page.items }; }";
const AT_LEAST = "export async function atLeast(input, io) { const page = await io.find('Room', { where: { seats: { gte: input.n } } }); return { result: page.items }; }";
const ADD = "export async function add(input, io) { return { result: await io.insert('Room', { id: io.new(), name: input.name, seats: input.seats }) }; }";
const IMPL = { add: ADD, bad: BAD, atLeast: AT_LEAST };

test('check names an unknown where operator', () => {
  const mod = parse(SPEC, 'main.arc');
  const found = check(mod, { impl: IMPL }).filter((item) => item.code === 'W038');
  assert.deepEqual(found.map((item) => [item.severity, item.file, item.path, item.message]), [
    ['warning', 'impl/bad.mjs', 'impl.bad', 'unknown where operator "nope"'],
  ]);
  assert.equal(check(mod, { impl: IMPL }).filter((item) => item.code === 'W038' && item.file === 'impl/atLeast.mjs').length, 0);
});

test('a brace inside a string does not hide the next operator', () => {
  // The literal is read by hand: a "}" inside a quoted value would end the
  // where object early, and every operator after it went unseen.
  const quoted = 'export async function look(input, io) { return { result: await io.find(\'Room\', { where: { note: { eq: "}" }, seats: { nope: 1 } } }) }; }';
  const found = check(parse(SPEC, 'main.arc'), { impl: { ...IMPL, look: quoted } })
    .filter((item) => item.code === 'W038' && item.file === 'impl/look.mjs');
  assert.deepEqual(found.map((item) => item.message), ['unknown where operator "nope"']);
});

test('the runtime answers 400 with the operator name', async () => {
  const service = await startService(SPEC, { impl: IMPL });
  try {
    const created = await fetch(service.base + '/v1/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', seats: 1 }),
    });
    assert.equal(created.status, 201);
    const response = await fetch(service.base + '/v1/rooms/bad');
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; message: string };
    assert.equal(body.error, 'Invalid');
    assert.equal(body.message, 'unknown where operator "nope"');
  } finally {
    await service.stop();
  }
});

test('a known operator still filters on kv', async () => {
  const service = await startService(SPEC, { impl: IMPL });
  try {
    for (const [name, seats] of [['a', 1], ['b', 2], ['c', 3]] as Array<[string, number]>) {
      const created = await fetch(service.base + '/v1/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, seats }),
      });
      assert.equal(created.status, 201);
    }
    const found = await fetch(service.base + '/v1/rooms/filter?n=2');
    assert.equal(found.status, 200);
    const rows = await found.json() as Array<{ name: string }>;
    assert.deepEqual(rows.map((row) => row.name).sort(), ['b', 'c']);
  } finally {
    await service.stop();
  }
});
