// quoteStr is the only place where a string value becomes source again. No
// example carries an escape, so the branches for a quote, a backslash, a
// newline, a tab and a carriage return were never run: a formatter that
// printed any of them raw would break the spec it is supposed to clean up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

const source = String.raw`module m @0.1.0 {}
type Row = { note: string = "a \"quoted\" \\ path\nline\tand tab\r" }
`;

test('a default string with every escape round-trips through fmt', () => {
  const out = formatSource(source, 'main.arc');
  assert.ok(out.includes(String.raw`\"quoted\"`), 'a quote is escaped');
  assert.ok(out.includes(String.raw`\\ path`), 'a backslash is escaped');
  assert.ok(out.includes(String.raw`\nline`), 'a newline is an escape, not a line break');
  assert.ok(out.includes(String.raw`\tand`), 'a tab is an escape');
  assert.ok(out.includes(String.raw`\r"`), 'a carriage return is an escape');
  // module header (2) + blank + the type + the final empty piece.
  assert.equal(out.split('\n').length, 5, 'the value did not open a new source line');
  assert.equal(formatSource(out, 'main.arc'), out, 'a second pass changes nothing');
  const value = parse(out, 'main.arc').types[0].type.kind === 'record'
    ? (parse(out, 'main.arc').types[0].type as any).fields[0].default.value
    : null;
  assert.equal(value, 'a "quoted" \\ path\nline\tand tab\r');
});
