import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

// A090 stops a lower bound that sits above its upper bound: such a type admits
// no value, every call gets a 400 and the schema still advertises it as
// usable. Size units are part of the bound — 'bytes(min: 2kb, max: 1kb)' is
// 2048 > 1024 — while the first version of the rule only read bare literals
// and stayed silent whenever a unit was written.

const wrap = (type: string) =>
  'module m @0.1.0 {}\n\nservice S : http {\n  contract {\n    public op g(x: ' + type + ') -> string {\n      route: "POST /v1/a"\n    }\n  }\n}\n';

const a090 = (type: string) => check(parse(wrap(type), 'm.arc')).filter((diag) => diag.code === 'A090');

test('a size unit takes part in the comparison', () => {
  const diags = a090('bytes(min: 2kb, max: 1kb)');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /bytes\(min: 2kb, max: 1kb\) admits no value/, 'the message quotes the source form, not converted bytes');
  assert.match(diags[0].hint ?? '', /min no greater than max/);
  assert.equal(a090('string(min: 2kb, max: 1500)').length, 1, 'a unit on one side and a plain count on the other still compare');
});

test('a size range that holds stays clean', () => {
  assert.deepEqual(a090('bytes(min: 800b, max: 1kb)'), []);
  assert.deepEqual(a090('bytes(min: 512, max: 2kb)'), []);
  assert.deepEqual(a090('string(min: 2, max: 2kb)'), []);
  assert.deepEqual(a090('bytes(max: 1kb)'), [], 'one bound alone cannot be reversed');
});

test('a bare numeric bound still reports and keeps its written form', () => {
  const diags = a090('int(min: 5, max: 1)');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /int\(min: 5, max: 1\) admits no value/);
  assert.deepEqual(a090('int(min: 1, max: 5)'), []);
});
