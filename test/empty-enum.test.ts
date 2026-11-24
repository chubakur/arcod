import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { constraintOf, describeViolation } from '../src/constraints.ts';

// An enum with no values is not a narrow type: it admits nothing. Both layers
// that read it fail without naming the declaration — OpenAPI publishes
// "enum": [] (JSON Schema requires at least one element) and the boundary
// rejects every value with an empty "must be one of " list — so check has to
// stop the file and point at the enum.

const empty = `module m @0.1.0 {}

enum E { }

service S : http {
  contract {
    public op g(x: E) -> string {
      route: "GET /v1/a"
    }
  }
}
`;

const declared = empty.replace('enum E { }', 'enum E { a, b }');

test('an enum with no values is an error that names the declaration', () => {
  const diags = check(parse(empty, 'm.arc'));
  const a100 = diags.filter((diag) => diag.code === 'A100');
  assert.equal(a100.length, 1, 'one error, not one per use site');
  assert.equal(a100[0].severity, 'error');
  assert.match(a100[0].message, /enum E declares no values/);
  assert.match(a100[0].hint ?? '', /at least one value/);
  assert.equal(a100[0].path, 'enums.E');
});

test('an empty enum admits nothing at the boundary, which is why it must stop', () => {
  const mod = parse(empty, 'm.arc');
  const param = mod.services[0].contract[0].kind === 'op' ? mod.services[0].contract[0].params[0] : null;
  assert.ok(param, 'the probe spec has one operation parameter');
  const constraint = constraintOf(mod, param.type);
  assert.deepEqual(constraint.enumValues, [], 'the allowed set is empty, not null');
  assert.equal(describeViolation(constraint, 'a'), 'must be one of ', 'every value is rejected, and the reason is empty');
});

test('an enum with values stays clean and keeps its set', () => {
  const mod = parse(declared, 'm.arc');
  const a100 = check(mod).filter((diag) => diag.code === 'A100');
  assert.deepEqual(a100, []);
  const param = mod.services[0].contract[0].kind === 'op' ? mod.services[0].contract[0].params[0] : null;
  assert.ok(param);
  assert.deepEqual(constraintOf(mod, param.type).enumValues, ['a', 'b']);
  assert.equal(describeViolation(constraintOf(mod, param.type), 'c'), 'must be one of a, b');
});
