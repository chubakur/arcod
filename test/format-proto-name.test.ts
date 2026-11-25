// The format table maps three builtin names (email, url, uri). It was read with
// a plain index, so a type or a format argument named like a prototype member
// answered Object.prototype.toString, which then became that type's format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { constraintOf, isFormatBuiltin } from '../src/constraints.ts';

const constraintOfField = (spec: string): unknown => {
  const mod = parse('module fmt @0.1.0 {}\n' + spec, 'main.arc');
  const decl = mod.types.find((item) => item.name === 'Box');
  assert.ok(decl && decl.type.kind === 'record', 'the fixture declares a record');
  return constraintOf(mod, decl.type.fields[0].type);
};

test('a type alias named like a prototype member carries no format', () => {
  for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
    const found = constraintOfField('type ' + name + ' = string\ntype Box = { value: ' + name + ' }\n');
    assert.deepEqual(found, { format: null, enumValues: null }, name);
  }
});

test('a format argument named like a prototype member carries no format', () => {
  const found = constraintOfField('type Box = { value: string(format: "toString") }\n');
  assert.deepEqual(found, { format: null, enumValues: null });
});

test('the real formats still map', () => {
  assert.equal(isFormatBuiltin('email'), true);
  assert.equal(isFormatBuiltin('toString'), false);
  assert.deepEqual(constraintOfField('type Box = { value: email }\n'), { format: 'email', enumValues: null });
  assert.deepEqual(constraintOfField('type Box = { value: url }\n'), { format: 'uri', enumValues: null });
});
