import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

// A cycle of bare aliases reaches no shape: 'type A = B' with 'type B = A'
// published "$ref": "A" -> "B" -> "A" in OpenAPI, which no tool can
// dereference, and an operation returning A had nothing the service could
// build. A cycle through a record is a different thing (a recursive shape) and
// stays legal.

const wrap = (types: string) => 'module m @0.1.0 {}\n\n' + types + '\nservice S : http {\n  contract {\n    public op g(x: A) -> A {\n      route: "POST /v1/a"\n    }\n  }\n}\n';

test('two aliases that point at each other are an error', () => {
  const mod = parse(wrap('type A = B\ntype B = A'), 'm.arc');
  const a101 = check(mod).filter((diag) => diag.code === 'A101');
  assert.equal(a101.length, 1, 'the cycle is reported once, not once per member');
  assert.equal(a101[0].severity, 'error');
  assert.match(a101[0].message, /A, B refer to each other and to no shape/);
  assert.match(a101[0].message, /A -> B -> A/);
  assert.match(a101[0].hint ?? '', /record, a builtin or an enum/);
});

test('an alias of itself is the same cycle with one member', () => {
  const mod = parse(wrap('type A = A'), 'm.arc');
  const a101 = check(mod).filter((diag) => diag.code === 'A101');
  assert.equal(a101.length, 1);
  assert.match(a101[0].message, /type A refers to itself/);
});

test('an alias that reaches a shape stays clean, including a recursive record', () => {
  const reached = parse(wrap('type A = B\ntype B = { id: uuid, name: string }'), 'm.arc');
  assert.deepEqual(check(reached).filter((diag) => diag.code === 'A101'), []);
  const recursive = parse(wrap('type A = { id: uuid, child: A? }'), 'm.arc');
  assert.deepEqual(check(recursive).filter((diag) => diag.code === 'A101'), [], 'a recursive shape is not an alias cycle');
});
