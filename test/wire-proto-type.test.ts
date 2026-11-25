// wireType fell back with a plain index, so an undeclared type named like a
// prototype member answered Object.prototype.toString: the prompt then printed
// the source text of that function as the field's wire type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { wireType } from '../src/prompts.ts';
import type { TypeExpr } from '../src/ast.ts';

const wireOf = (typeText: string): string => {
  const mod = parse('module wire @0.1.0 {}\ntype Box = { value: ' + typeText + ' }\n', 'main.arc');
  const decl = mod.types.find((item) => item.name === 'Box');
  assert.ok(decl && decl.type.kind === 'record', 'the fixture declares a record');
  const named = new Map<string, TypeExpr>(mod.types.map((item) => [item.name, item.type]));
  return wireType(decl.type.fields[0].type, named);
};

test('an undeclared type named like a prototype member falls back to string', () => {
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    assert.equal(wireOf(name), 'string', name);
  }
});

test('a declared alias is still followed to its wire type', () => {
  const mod = parse('module wire @0.1.0 {}\ntype Id = uuid\ntype Box = { value: Id }\n', 'main.arc');
  const decl = mod.types.find((item) => item.name === 'Box');
  assert.ok(decl && decl.type.kind === 'record');
  const named = new Map<string, TypeExpr>(mod.types.map((item) => [item.name, item.type]));
  assert.equal(wireType(decl.type.fields[0].type, named), 'string');
});

test('builtins keep their own wire type', () => {
  assert.equal(wireOf('number'), 'number');
  assert.equal(wireOf('boolean'), 'boolean');
  assert.equal(wireOf('uuid'), 'string');
  assert.equal(wireOf('bytes'), 'string');
});
