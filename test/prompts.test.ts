import test from 'node:test';
import assert from 'node:assert/strict';
import type { Expr, Loc, TypeExpr } from '../src/ast.ts';
import { estimateTokens, exprText, typeText } from '../src/prompts.ts';

// A prompt tells the model what the contract means. If an expression or a
// refined type renders as an empty string, the model writes a body against a
// rule it never saw, so every AST form has to have a spelling.

const loc: Loc = { line: 1, col: 1, endLine: 1, endCol: 2, offset: 0, end: 1 };
const lit = (raw: string, value: string | number | boolean | null = raw): Expr => ({ kind: 'literal', raw, value, loc });
const ident = (name: string): Expr => ({ kind: 'ident', name, loc });

test('exprText spells every expression form the parser produces', () => {
  assert.equal(exprText(lit('42', 42)), '42');
  assert.equal(exprText({ kind: 'duration', value: 5, unit: 's', loc }), '5s');
  assert.equal(exprText({ kind: 'member', object: ident('io'), property: 'store', loc }), 'io.store');
  assert.equal(
    exprText({ kind: 'call', callee: ident('io.insert'), args: [{ name: 'id', value: lit('"x"'), loc }, { value: ident('row'), loc }], loc }),
    'io.insert(id: "x", row)',
  );
  assert.equal(exprText({ kind: 'unary', op: '!', operand: ident('ok'), loc }), '!ok');
  assert.equal(exprText({ kind: 'binary', op: '+', left: lit('1', 1), right: lit('2', 2), loc }), '1 + 2');
  assert.equal(exprText({ kind: 'is', expr: ident('e'), error: 'NotFound', loc }), 'e is NotFound');
  assert.equal(exprText({ kind: 'list', items: [lit('1', 1), lit('"a"')], loc }), '[1, "a"]');
  assert.equal(
    exprText({ kind: 'record', fields: [{ name: 'a', value: lit('1', 1), loc }, { name: 'b', value: ident('x'), loc }], loc }),
    '{ a: 1, b: x }',
  );
});

test('typeText spells refinements, unions, optionals and defaults', () => {
  assert.equal(typeText({ kind: 'optional', inner: identType('string'), loc }), 'string?');
  assert.equal(typeText({ kind: 'union', variants: [identType('A'), identType('B')], loc }), 'A | B');
  assert.equal(
    typeText({
      kind: 'named',
      name: 'bytes',
      args: [{ name: 'max', value: { kind: 'duration', value: 64, unit: 'kb', loc }, loc }],
      loc,
    }),
    'bytes(max: 64kb)',
  );
  assert.equal(
    typeText({
      kind: 'record',
      fields: [{ name: 'tags', type: { kind: 'named', name: 'list', args: [{ value: identType('string'), isType: true, loc }], loc }, default: { kind: 'list', items: [], loc }, loc }],
      loc,
    }),
    '{ tags: list(string) = [] }',
  );
});

function identType(name: string): TypeExpr {
  return { kind: 'named', name, args: [], loc };
}

test('estimateTokens is a stable four-characters-per-token estimate', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});
