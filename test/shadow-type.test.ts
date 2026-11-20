// A declaration may carry a builtin name (`type int = string`). OpenAPI
// listed the declaration under components while every use site resolved the
// builtin first, so one module produced two contracts: `{"type": "string"}`
// for `int` and an integer for the field of that type. A089 rejects the name;
// adopt renames such a schema so its own output stays compilable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { adoptOpenapi } from '../src/adopt.ts';

function moduleOf(body: string): ReturnType<typeof parse> {
  return parse('module m @0.1.0 {\n}\n\n' + body + '\n', 'types.arc');
}

function a089(body: string): ReturnType<typeof check> {
  return check(moduleOf(body)).filter((item) => item.code === 'A089');
}

test('a type named after a builtin is A089 with a rename hint', () => {
  const diags = a089('type int = string');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'types.int');
  assert.match(diags[0].message, /type int shadows a builtin name/);
  assert.match(diags[0].hint ?? '', /rename the declaration, e\.g\. Int/);
});

test('an enum named after a builtin is A089 too', () => {
  const diags = a089('enum uuid { v1 }');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, 'types.uuid');
  assert.match(diags[0].message, /type uuid shadows a builtin name/);
});

test('a name that only looks builtin is accepted', () => {
  assert.deepEqual(a089('type Int = string'), []);
  assert.deepEqual(a089('type Count = int'), []);
});

test('adopt renames a schema that collides with a builtin', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'getItem',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/int' } } },
            },
          },
        },
      },
    },
    components: { schemas: { int: { type: 'string' } } },
  };
  const out = adoptOpenapi(doc);
  assert.match(out, /type int_ = string/);
  assert.match(out, /-> int_/);
  assert.doesNotMatch(out, /type int =/);
  assert.deepEqual(check(parse(out, 'main.arc')).filter((diag) => diag.severity === 'error'), []);
});
