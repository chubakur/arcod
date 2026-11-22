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

test('a call keeps the parentheses its callee needs', () => {
  // member and call both bind tighter than every operator: \`(x + y).abs()\`
  // needs its parentheses, \`s.get(x).value\` does not gain any. No example
  // spells either shape, so both printer paths were unexercised.
  const src = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    public op a(x: int, y: int) -> int {',
    '      route: ""',
    '      post: (x + y).abs() == x',
    '    }',
    '    public op b(x: int) -> int {',
    '      route: ""',
    '      post: s.get(x).value == x',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /post: \(x \+ y\)\.abs\(\) == x/);
  assert.match(out, /post: s\.get\(x\)\.value == x/);
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('unary minus keeps the operand parentheses the precedence needs', () => {
  // Unary prints its operand at 7, above the product level (6): a negated
  // product keeps its parentheses, a product of a negation does not. No
  // example negates anything, so both sides of that decision were unexercised.
  const src = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    public op a(x: int, y: int) -> bool {',
    '      route: ""',
    '      post: -x * y == 0',
    '    }',
    '    public op b(x: int, y: int) -> bool {',
    '      route: ""',
    '      post: -(x * y) == 0',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /post: -x \* y == 0/);
  assert.match(out, /post: -\(x \* y\) == 0/);
  const clause: any = parse(out, 'main.arc').services[0].contract[1].clauses.find((c: any) => c.kind === 'post');
  const e = clause.expr;
  assert.equal(e.left.kind, 'unary');
  assert.equal(e.left.operand.kind, 'binary');
  assert.equal(formatSource(out, 'main.arc'), out);
});
