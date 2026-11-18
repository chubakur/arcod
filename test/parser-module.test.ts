import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

// The module header braces hold one meta block and nothing else. Anything
// else used to be skipped token by token, so a declaration written one brace
// too deep vanished and arcod check called the file clean: a typo compiled to
// a no-op. These tests pin the refusal, its message and its location.

function header(body: string): string {
  return ['module demo @0.1.0 {', body, '}'].join('\n');
}

function parseError(source: string): ParseError {
  try {
    parse(source, 'demo.arc');
  } catch (error) {
    assert.ok(error instanceof ParseError, 'expected a ParseError, got ' + String(error));
    return error;
  }
  assert.fail('expected the parser to refuse the source');
}

test('a declaration inside the module header is refused, not dropped', () => {
  const error = parseError(header('  type T = { x: int }'));
  assert.match(error.message, /unexpected token "type" in the module header/);
  assert.match(error.message, /declarations go after the closing/);
  assert.equal(error.loc.line, 2);
  assert.equal(error.loc.col, 3);
});

test('an unknown token inside the module header is refused', () => {
  const error = parseError(header('  garbage'));
  assert.match(error.message, /unexpected token "garbage"/);
});

test('a second meta block is refused instead of merged', () => {
  const error = parseError(header('  meta { title: "a" }\n  meta { title: "b" }'));
  assert.match(error.message, /duplicate .meta. block/);
  assert.equal(error.loc.line, 3);
});

test('a repeated meta key is refused and points at the key', () => {
  const error = parseError(header('  meta { title: "a" title: "b" }'));
  assert.match(error.message, /duplicate meta key "title"/);
  assert.equal(error.loc.line, 2);
  assert.equal(error.loc.col, 21);
});

test('one meta block with comma-separated keys still parses', () => {
  const mod = parse(header('  meta { title: "a", owner: "@me" }'), 'demo.arc');
  assert.deepEqual(mod.meta, { title: 'a', owner: '@me' });
  assert.equal(mod.name, 'demo');
  assert.equal(mod.version, '0.1.0');
});

test('an empty header and a header without meta parse', () => {
  assert.deepEqual(parse('module demo @0.1.0 {\n}', 'demo.arc').meta, {});
  const mod = parse('module demo {\n}\n\ntype T = { x: int }\n', 'demo.arc');
  assert.equal(mod.version, '0.0.0');
  assert.equal(mod.types.length, 1);
});

test('the same declaration outside the braces stays clean', () => {
  const error = parseError(header('  type T'));
  assert.equal(error.name, 'ParseError');
  const clean = parse(['module demo @0.1.0 {', '}', '', 'type T = { x: int }'].join('\n'), 'demo.arc');
  assert.deepEqual(check(clean), []);
});
