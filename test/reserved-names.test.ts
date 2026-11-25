import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

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
