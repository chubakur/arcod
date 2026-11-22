// The union type and the precedence printer were the two spots no example
// reached: specs use `T?` for optional, and no example nests arithmetic inside
// a comparison inside a boolean. fmt has to print both back so the file parses
// to the same model, and to the same text on the next run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../src/fmt.ts';
import { parse } from '../src/parser.ts';

test('a union type survives fmt in a field and inside a list', () => {
  const source = 'module m @0.1.0 {}' + String.fromCharCode(10)
    + 'type Row = { v: string | int, w: list<string | int> }' + String.fromCharCode(10);
  const out = formatSource(source, 'main.arc');
  assert.match(out, /v: string \| int/);
  assert.match(out, /list<string \| int>/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});

test('precedence keeps the parentheses the expression needs', () => {
  const source = [
    'module m @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    public op a(x: int, y: int) -> bool {',
    '      route: "GET /v1/a"',
    '      post: (x + 1) * 2 == 6 && !false || x is NotFound',
    '    }',
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
  const out = formatSource(source, 'main.arc');
  assert.match(out, /post: \(x \+ 1\) \* 2 == 6 && !false \|\| x is NotFound/);
  parse(out, 'main.arc');
  assert.equal(formatSource(out, 'main.arc'), out);
});
