// A comment written inside a type/error/enum body after its last field has no
// node of its own. The leading-comment rule used to anchor it on the next
// declaration, so it slid out of the braces (and, with no next declaration, to
// the end of the file). It keeps its place before the closing brace now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

const format = (source: string): string => formatSource(source, 'main.arc');

test('a comment after the last record field stays inside the braces', () => {
  const source = [
    'module m @0.1.0 {}',
    'type Row = {',
    '  id: uuid',
    '  // note about Row',
    '}',
    '',
    'type Next = { id: uuid }',
    '',
  ].join('\n');
  const out = format(source);
  assert.equal(out, [
    'module m @0.1.0 {',
    '}',
    '',
    'type Row = {',
    '  id: uuid',
    '  // note about Row',
    '}',
    '',
    'type Next = { id: uuid }',
    '',
  ].join('\n'));
  parse(out, 'main.arc');
  assert.equal(format(out), out, 'a second pass changes nothing');
});

test('a record with no fields but a comment stays multi-line', () => {
  const out = format('module m @0.1.0 {}\ntype Empty = {\n  // nothing yet\n}\n');
  assert.equal(out, 'module m @0.1.0 {\n}\n\ntype Empty = {\n  // nothing yet\n}\n');
  assert.equal(format(out), out);
});

test('an error body keeps a comment after its last field', () => {
  const out = format('module m @0.1.0 {}\nerror Bad {\n  reason: string\n  // the error ends here\n}\n');
  assert.match(out, /^error Bad \{\n  reason: string\n  \/\/ the error ends here\n\}$/m);
  assert.equal(format(out), out);
});

test('an enum body keeps a comment after its last value', () => {
  const out = format('module m @0.1.0 {}\nenum Plan {\n  free,\n  pro\n  // no more tiers\n}\n');
  assert.match(out, /^enum Plan \{\n  free,\n  pro\n  \/\/ no more tiers\n\}$/m);
  assert.equal(format(out), out);
});

const service = (contract: string[]): string => [
  'module m @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'service S : http {',
  '  uses store: kv',
  '  contract {',
  ...contract,
  '  }',
  '}',
  '',
].join('\n');

test('a comment after the last operation stays inside the contract block', () => {
  const out = format(service([
    '    public op a() -> { ok: bool } {',
    '      route: "/v1/a"',
    '    }',
    '    // note after the last op',
  ]));
  assert.match(out, /^    \}\n    \/\/ note after the last op\n  \}\n\}$/m);
  assert.equal(format(out), out);
});

test('a comment after the last clause stays inside the operation', () => {
  const out = format(service([
    '    public op a() -> { ok: bool } {',
    '      route: "/v1/a"',
    '      // inside the op',
    '    }',
    '    public op b() -> { ok: bool } {',
    '      route: "/v1/b"',
    '    }',
  ]));
  // It used to be printed above the next operation, at the contract's indent.
  assert.match(out, /^      route: "\/v1\/a"\n      \/\/ inside the op\n    \}$/m);
  assert.equal(format(out), out);
});

test('a comment after the last service block stays inside the service', () => {
  const out = format(service([
    '    public op a() -> { ok: bool } {',
    '      route: "/v1/a"',
    '    }',
  ]).replace('  }\n}\n', '  }\n  // the service ends here\n}\n'));
  assert.match(out, /^  \}\n  \/\/ the service ends here\n\}$/m);
  assert.equal(format(out), out);
});

test('a comment after the last service meta entry stays inside meta', () => {
  const out = format([
    'module m @0.1.0 {}',
    'use capability arcod.std.kv @1',
    'service S : http {',
    '  meta {',
    '    title: "shop"',
    '    // last meta note',
    '  }',
    '  uses store: kv',
    '}',
    '',
  ].join('\n'));
  assert.match(out, /^  meta \{\n    title: "shop"\n    \/\/ last meta note\n  \}$/m);
  assert.equal(format(out), out);
});

test('a comment after the last example statement stays inside the example', () => {
  const out = format([
    'module m @0.1.0 {}',
    'use capability arcod.std.kv @1',
    'service S : http {',
    '  uses store: kv',
    '  contract {',
    '    public op a() -> { ok: bool } {',
    '      route: "/v1/a"',
    '    }',
    '  }',
    '  examples {',
    '    example one {',
    '      when {',
    '        a()',
    '      }',
    '      then {',
    '        true',
    '        // last check note',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.match(out, /^      \}\n      \/\/ last check note\n    \}$/m);
  assert.equal(format(out), out);
});

test('a multi-line block comment inside a record keeps its alignment and is idempotent', () => {
  const out = format('module m @0.1.0 {}\ntype Row = {\n  /* a note\n     across lines */\n  id: uuid\n}\n');
  assert.equal(out, [
    'module m @0.1.0 {',
    '}',
    '',
    'type Row = {',
    '  /* a note',
    '     across lines */',
    '  id: uuid',
    '}',
    '',
  ].join('\n'));
  // The continuation line used to gain two spaces on every format pass.
  assert.equal(format(out), out);
});
