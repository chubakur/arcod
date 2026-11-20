// adopt keeps the integer bounds a document states. An exclusive bound is a
// different set of integers than an inclusive one, and a fractional bound on
// an integer type is the tightest whole number it allows; mapping either to
// the raw number would widen the adopted contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptOpenapi } from '../src/adopt.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function docWith(parameter: Record<string, unknown>) {
  return {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', ...parameter } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: { schemas: {} },
  };
}

function adopted(parameter: Record<string, unknown>): string {
  const out = adoptOpenapi(docWith(parameter));
  assert.deepEqual(check(parse(out, 'main.arc')).filter((diag) => diag.severity === 'error'), []);
  return out;
}

test('OpenAPI 3.0 exclusiveMinimum true tightens minimum by one', () => {
  assert.match(adopted({ minimum: 0, exclusiveMinimum: true }), /limit: int\(min: 1\)\?/);
});

test('OpenAPI 3.1 numeric exclusive bounds become the nearest integers', () => {
  assert.match(adopted({ exclusiveMinimum: 0, exclusiveMaximum: 10 }), /limit: int\(min: 1, max: 9\)\?/);
});

test('a fractional bound on an integer is rounded into the allowed set', () => {
  assert.match(adopted({ minimum: 1.5, maximum: 9.5 }), /limit: int\(min: 2, max: 9\)\?/);
});
