// A bound pair that admits nothing is a model error: every caller gets a 400
// and every default is A060, while the schema advertises the type as usable.
// A typo in one of the two numbers is the whole cause, so check names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function a090(body: string): ReturnType<typeof check> {
  return check(parse('module m @0.1.0 {\n}\n\n' + body + '\n', 'types.arc'))
    .filter((item) => item.code === 'A090');
}

test('an integer range with min above max is A090', () => {
  const diags = a090('type Item = { age: int(min: 10, max: 5) }');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'types.int');
  assert.match(diags[0].message, /int\(min: 10, max: 5\) admits no value/);
  assert.match(diags[0].hint ?? '', /min no greater than max/);
});

test('a real and a length range are judged the same way', () => {
  assert.equal(a090('type Item = { price: number(min: 2.5, max: 0.5) }').length, 1);
  assert.equal(a090('type Item = { name: string(min: 5, max: 3) }').length, 1);
});

test('an equal or ordered range is clean', () => {
  assert.deepEqual(a090('type Item = { age: int(min: 5, max: 5) }'), []);
  assert.deepEqual(a090('type Item = { age: int(min: 1, max: 5) }'), []);
  assert.deepEqual(a090('type Item = { age: int(max: 5) }'), []);
});
