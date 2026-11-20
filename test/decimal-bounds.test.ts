// `format: decimal` is money: the source states a scale, so adopting it as a
// float (`number`) lost both the exactness and, now, the bound. The type is
// `decimal`, which the migration already maps to DECIMAL(30,6), and a decimal
// bound reads like a real one — schema, 400 and A060.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { adoptOpenapi } from '../src/adopt.ts';

function docWith(schema: Record<string, unknown>) {
  return {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/prices': {
        get: {
          operationId: 'listPrices',
          parameters: [{ name: 'price', in: 'query', schema: { type: 'number', format: 'decimal', ...schema } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: { schemas: {} },
  };
}

test('a decimal parameter carries its bound in the schema', () => {
  const source = [
    'module m @0.1.0 {',
    '}',
    '',
    'service Prices : http {',
    '  contract {',
    '    public op read(price: decimal(min: 0.5, max: 99.5)) -> { price: decimal } {',
    '      route: "GET /v1/price"',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const doc = emitOpenapi(parse(source, 'x.arc'));
  const param = (doc.paths as any)['/v1/price'].get.parameters[0];
  assert.deepEqual(param.schema, { type: 'number', format: 'decimal', minimum: 0.5, maximum: 99.5 });
});

test('adopt keeps a decimal a decimal and its bound', () => {
  const out = adoptOpenapi(docWith({ minimum: 1.5 }));
  assert.match(out, /price: decimal\(min: 1\.5\)/);
  assert.deepEqual(check(parse(out, 'main.arc')).filter((diag) => diag.severity === 'error'), []);
});

test('a default outside a decimal bound is A060', () => {
  const diags = check(parse('module m @0.1.0 {\n}\ntype Item = { price: decimal(min: 0.5) = 0.1 }', 'x.arc'))
    .filter((diag) => diag.code === 'A060');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /must be >= 0.5/);
});
