// Two printer paths no example reaches: a record literal as an expression and
// the precedence that lets `(x is E) == false` drop its parentheses. The
// second one is only safe if the parser binds `is` tighter than `==`, so the
// test reparses the canonical line and checks the same shape came back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

const source = [
  'module m @0.1.0 {}',
  'service S : http {',
  '  contract {',
  '    public op a(x: int, y: int) -> bool {',
    '      route: ""',
    '      post: { ok: (x + y).abs == 1 } == { ok: true }',
    '    }',
    '    public op b(x: int) -> bool {',
    '      route: ""',
    '      post: (x is NotFound) == false',
    '    }',
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));

const post = (text: string, index: number): any => {
  const op: any = parse(formatSource(text, 'main.arc'), 'main.arc').services[0].contract[index];
  return op.clauses.find((c: any) => c.kind === 'post').expr;
};

test('a record literal is printed with its fields, not expanded', () => {
  const out = formatSource(source, 'main.arc');
  assert.match(out, /post: \{ ok: \(x \+ y\)\.abs == 1 \} == \{ ok: true \}/);
  assert.equal(post(source, 0).kind, 'binary');
  assert.equal(post(formatSource(out, 'main.arc'), 0).kind, 'binary');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('parentheses around an `is` comparison are dropped and mean the same', () => {
  const out = formatSource(source, 'main.arc');
  assert.match(out, /post: x is NotFound == false/);
  const e = post(out, 1);
  assert.equal(e.kind, 'binary');
  assert.equal(e.left.kind, 'is');
  assert.equal(e.left.error, 'NotFound');
});
