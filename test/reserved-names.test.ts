import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';
import { startService } from './harness.ts';

// A102: `__proto__` is an object-literal key, not a name the toolchain can
// carry. Before this check, a *field* of this name disappeared from OpenAPI
// (`properties` had it neither in the map nor in `required`) while the DDL
// kept the column, and a *type* of this name crashed `arcod build` with
// "uniques.some is not a function" after check had reported the file clean.
// The spec has to stop at check time instead.

const moduleHeader = 'module m @0.1.0 {\n}\n\n';
const service = (contract: string) =>
  '\nservice S : http {\n  uses store: kv\n\n  contract {\n' + contract + '  }\n}\n';

const codes = (source: string) =>
  check(parse(moduleHeader + source, 'x.arc')).map((d) => ({
    code: d.code,
    path: d.path ?? '',
    message: d.message,
    hint: d.hint,
  }));

const a102 = (source: string) => codes(source).filter((d) => d.code === 'A102');

test('a type named __proto__ is refused', () => {
  const found = a102('type __proto__ = { id: uuid }\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'types.__proto__');
  assert.match(found[0].message, /type name __proto__ is reserved/);
  assert.match(found[0].hint ?? '', /keyed by name/);
});

test('a record field named __proto__ is refused and the location is the field', () => {
  const found = a102('type Note = { id: uuid, __proto__: string }\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'types.Note.fields.__proto__');
  assert.match(found[0].message, /field name __proto__ is reserved/);
});

test('an error field named __proto__ is refused', () => {
  const found = a102('error Invalid { __proto__: string }\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'errors.Invalid.fields.__proto__');
});

test('a service, its operation and a parameter are each refused', () => {
  const found = a102('service __proto__ : http {\n}\n' + service('    public op __proto__(__proto__: string) -> string {}\n'));
  assert.deepEqual(found.map((d) => d.path).sort(), [
    'services.S.contract.__proto__',
    'services.S.contract.__proto__.params.__proto__',
    'services.__proto__',
  ]);
});

test('a ui named __proto__ is refused', () => {
  const found = a102('ui __proto__ {\n  kind: spa\n  route: "/"\n}\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'uis.__proto__');
});

test('other odd names stay accepted: constructor, toString, proto, metadata', () => {
  const source =
    'type Note = { id: uuid, constructor: int, toString: string, proto: string, metadata: json }\n' +
    service('    public op create(constructor: int) -> Note {\n      route: "POST /api/notes"\n    }\n');
  assert.deepEqual(a102(source), []);
});

test('every A102 occurrence carries the same hint, so one README entry covers them', () => {
  const found = a102('type __proto__ = { __proto__: string }\n');
  assert.equal(found.length, 2);
  for (const item of found) assert.match(item.hint ?? '', /rename it/);
});

// The A102 hint says constructor and toString are ordinary keys, not reserved
// ones. That is a claim about the runtime, not about the parser: the record
// check reads its bounds table by field name at insert time. A live service
// proves the claim, and the test fails if someone later widens the reserved
// set to names that actually work.
const liveSource = [
  'module probe @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Item = { id: uuid, constructor: string(max: 3), toString: int? }',
  '',
  'error Invalid',
  '',
  'service Probe : http {',
  '  uses store: kv',
  '  uses uuid: ids',
  '',
  '  effects {',
  '    allow store.insert, store.get, uuid.new',
  '  }',
  '',
  '  contract {',
  '    public op put(name: string) -> Item {',
  '      route: "POST /v1/items"',
  '      effects: store.insert, uuid.new',
  '      errors: Invalid',
  '    }',
  '',
  '    public op read(id: uuid) -> Item? {',
  '      route: "GET /v1/items/:id"',
  '      effects: store.get',
  '    }',
  '  }',
  '}',
  '',
].join(String.fromCharCode(10));

const liveImpl = {
  put: [
    'export async function put(input, io) {',
    "  return { result: await io.insert('Item', { id: io.new(), constructor: input.name }) };",
    '}',
  ].join(String.fromCharCode(10)),
  read: [
    'export async function read(input, io) {',
    "  return { result: await io.fetch('Item', input.id) };",
    '}',
  ].join(String.fromCharCode(10)),
};

async function putLive(body: Record<string, unknown>) {
  const svc = await startService(liveSource, { impl: liveImpl });
  try {
    const res = await fetch(svc.base + '/v1/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const created = res.status === 201 ? (JSON.parse(text) as { id: string }) : null;
    const read = created
      ? await fetch(svc.base + '/v1/items/' + created.id).then(async (r) => ({ status: r.status, text: await r.text() }))
      : null;
    return { status: res.status, text, read };
  } finally {
    await svc.stop();
  }
}

test('a field named constructor keeps its bound at insert time', async () => {
  const res = await putLive({ name: 'abcdef' });
  assert.equal(res.status, 400);
  assert.match(res.text, /insert Item: constructor must be at most 3 characters/);
});

test('a field named constructor is stored and read back under its own key', async () => {
  const res = await putLive({ name: 'abc' });
  assert.equal(res.status, 201, res.text);
  const body = JSON.parse(res.text) as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, 'constructor'), true);
  assert.equal(body.constructor, 'abc');
  // An omitted optional field named toString is a column like any other: the
  // fetch names it with null instead of leaving the inherited function in its
  // place (that leak turned the insert into "toString must be a number").
  assert.equal(res.read?.status, 200, 'read body: ' + (res.read?.text ?? ''));
  const row = JSON.parse(res.read?.text ?? '{}') as Record<string, unknown>;
  assert.equal(Object.hasOwn(row, 'toString'), true);
  assert.equal(row.toString, null);
  assert.equal(row.constructor, 'abc');
});
