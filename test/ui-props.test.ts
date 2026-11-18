import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.ts';
import { formatSource } from '../src/fmt.ts';

const head = 'module m @0.1.0 {}\n';

function parseError(src: string): ParseError {
  try {
    parse(src, 'main.arc');
  } catch (e) {
    assert.ok(e instanceof ParseError, 'expected a ParseError, got ' + String(e));
    return e;
  }
  assert.fail('the spec parsed, but it should not');
}

test('an unknown ui property is a parse error, not a silent drop', () => {
  // It used to parse and vanish: check was clean, fmt deleted the line.
  const err = parseError(head + 'ui Board {\n  kind: spa\n  subtitle: "nope"\n}\n');
  assert.match(err.message, /unknown ui property "subtitle"/);
  assert.match(err.message, /expected kind, route, title/);
  assert.equal(err.loc.line, 4);
  assert.equal(err.loc.col, 3);
});

test('an unknown slide property is a parse error', () => {
  const err = parseError(head + 'ui Deck {\n  kind: spa\n  slide "One" {\n    notes: "speaker notes"\n  }\n}\n');
  assert.match(err.message, /unknown slide property "notes"/);
  assert.match(err.message, /a slide takes only body/);
  assert.equal(err.loc.line, 5);
});

test('a slide body that is not a quoted string is refused', () => {
  const err = parseError(head + 'ui Deck {\n  kind: spa\n  slide "One" {\n    body: Hello\n  }\n}\n');
  assert.match(err.message, /slide body must be a quoted string/);
});

test('every known ui property still parses and survives fmt', () => {
  const src = head + [
    'ui Board {',
    '  kind: spa',
    '  route: "/board"',
    '  title: "Board"',
    '  layout: forms',
    '  locale: "ru"',
    '  locales: "en, ru"',
    '  theme: dark',
    '  render: ssr',
    '  history: Api.history',
    '  send: Api.send',
    '  start: Api.start',
    '  join: Api.join',
    '  state: Api.state',
    '  advance: Api.advance',
    '  uses Api.list',
    '  slide "One" {',
    '    body: "Hello"',
    '  }',
    '}',
    '',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out, 'stable on a second pass');
  assert.match(out, /^  locale: "ru"$/m);
  assert.match(out, /^  locales: "en, ru"$/m);
  assert.match(out, /^  slide "One" \{$/m);
});
