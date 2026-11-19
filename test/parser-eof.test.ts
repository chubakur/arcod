import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, parse } from '../src/parser.ts';

// Every parser complaint echoes the token it choked on. At end of file that
// token's value is the empty string, so a truncated spec used to read
// `expected "module", got ""` — which looks like a typo in the message rather
// than a file cut in half. These tests pin the wording: the token is named.

function parseError(source: string): ParseError {
  try {
    parse(source, 'demo.arc');
  } catch (error) {
    assert.ok(error instanceof ParseError, 'expected a ParseError, got ' + String(error));
    return error;
  }
  assert.fail('expected the parser to refuse the source');
}

test('an empty file says end of file, not an empty string', () => {
  const error = parseError('');
  assert.equal(error.message, 'expected "module", got end of file');
  assert.deepEqual([error.loc.line, error.loc.col], [1, 1]);
});

test('a file that stops in the module header names the end of file', () => {
  const error = parseError('module demo @0.1.0 {\n  meta {\n');
  assert.equal(error.message, 'expected meta key, got end of file');
});

test('a header without its closing brace keeps the dedicated header message', () => {
  const error = parseError('module demo @0.1.0 {\n  meta {\n  }\n');
  assert.match(error.message, /^unexpected end of file/);
});

test('a truncated declaration names the end of file in expect()', () => {
  const error = parseError('module demo @0.1.0\n');
  assert.equal(error.message, 'expected "{", got end of file');
});

test('a contract cut after its opening brace reports what it expected instead', () => {
  const error = parseError([
    'module demo @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'service Demo : http {',
    '  contract {',
    '',
  ].join('\n'));
  assert.equal(error.message, 'expected op or job, got end of file');
});

test('an ordinary bad token still prints its text in quotes', () => {
  const error = parseError('module demo @0.1.0\n42\n');
  assert.equal(error.message, 'expected "{", got "42"');
});

test('the empty-string spelling never leaks into a parse error', () => {
  for (const source of ['', 'module demo @0.1.0 {\n', '   \n\n', '// note\n']) {
    assert.ok(!parseError(source).message.includes('got ""'), 'leaked got "" for ' + JSON.stringify(source));
  }
});
