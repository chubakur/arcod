import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexError, lex } from '../src/lexer.ts';
import { ParseError, parse } from '../src/parser.ts';

// The lexer is the first gate a spec passes. Its token stream and its two
// refusals (unterminated string, unknown character) decide whether the user
// sees a located error or a stack trace, and nothing pinned either.

function kinds(source: string): string[] {
  return lex(source).map((token) => token.kind);
}

test('comments disappear before the parser sees them', () => {
  const source = [
    '// line comment with "quotes" and { braces }',
    'module demo @0.1.0 /* block comment',
    '   spanning lines */ {',
    '  meta { owner: "@you" }',
    '}',
    '// trailing comment without a newline',
  ].join('\n');
  const tokens = lex(source);
  assert.deepEqual(tokens.map((token) => token.value).filter((value) => value === 'module'), ['module']);
  assert.ok(tokens.every((token) => !token.value.includes('comment')), 'comments never reach the stream');
});

test('an unterminated block comment stops at end of file without throwing', () => {
  const tokens = lex('module demo @0.1.0 /* never closed');
  assert.equal(tokens.at(-1)?.kind, 'eof');
  assert.ok(tokens.some((token) => token.value === 'module'));
});

test('string escapes decode and unknown escapes keep their character', () => {
  // Built from code points so the test itself does not have to escape twice.
  const bs = String.fromCharCode(92);
  const source = '"a' + bs + 'nb' + bs + 'tc' + bs + 'rd' + bs + bs + 'e' + bs + 'qf"';
  const value = lex(source).find((token) => token.kind === 'string')!.value;
  assert.ok(value.startsWith('a'));
  assert.ok(value.includes('\n'), 'backslash-n becomes a newline');
  assert.ok(value.includes('\t'), 'backslash-t becomes a tab');
  assert.ok(value.includes('\r'), 'backslash-r becomes a carriage return');
  assert.ok(value.includes(bs), 'a doubled backslash survives as one');
  assert.ok(value.endsWith('qf'), 'an unknown escape keeps its character');
});

test('a string broken by a newline is a located lex error', () => {
  assert.throws(
    () => lex('module demo @0.1.0 {\n  meta { owner: "unclosed\n  }\n}'),
    (error: unknown) => {
      assert.ok(error instanceof LexError);
      assert.equal(error.message, 'unterminated string');
      assert.equal(error.line, 2, 'points at the opening quote, not the newline');
      assert.equal(error.col, 17, 'the opening quote');
      assert.equal(typeof error.offset, 'number');
      return true;
    },
  );
});

test('a string that hits end of file is reported too', () => {
  assert.throws(() => lex('"no closing quote'), /unterminated string/);
});

test('an unexpected character names itself and its position', () => {
  assert.throws(
    () => lex('module demo @0.1.0 {\n  meta { owner: $ }\n}'),
    (error: unknown) => {
      assert.ok(error instanceof LexError);
      assert.equal(error.message, 'unexpected character "$"');
      assert.equal(error.line, 2);
      assert.equal(error.col, 17);
      return true;
    },
  );
});

test('parse turns a lex error into a ParseError with the same location', () => {
  assert.throws(
    () => parse('module demo @0.1.0 {\n  meta { owner: $ }\n}', 'main.arc'),
    (error: unknown) => {
      assert.ok(error instanceof ParseError, 'callers only ever see ParseError');
      assert.equal(error.loc.line, 2);
      assert.equal(error.loc.col, 17);
      assert.equal(error.loc.endCol, 18);
      assert.ok(error.loc.offset > 0);
      return true;
    },
  );
});

test('token coordinates stay stable across lines', () => {
  const tokens = lex('module a @0.1.0 {\n\n  error NotFound\n}');
  const errorToken = tokens.find((token) => token.value === 'error')!;
  assert.equal(errorToken.line, 3);
  assert.equal(errorToken.col, 3);
  const eof = tokens.at(-1)!;
  assert.equal(eof.kind, 'eof');
  assert.equal(kinds('').length, 1, 'an empty source is just eof');
});

test('a UTF-8 BOM is encoding, not a character of the spec', () => {
  const plain = lex('module m @0.1.0 {\n}\n');
  const bom = lex('\uFEFFmodule m @0.1.0 {\n}\n');
  const shape = (tokens: typeof plain) => tokens.map((t) => [t.kind, t.value, t.line, t.col]);
  assert.deepEqual(shape(bom), shape(plain), 'the first token starts at 1:1 either way');
  assert.equal(bom[0].offset, plain[0].offset + 1, 'offsets stay real positions in the file');
});
