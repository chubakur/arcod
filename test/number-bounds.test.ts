// A real bound is a contract fact like an integer bound: adopt keeps OpenAPI
// `minimum`/`maximum` on a number as `number(min:, max:)`, and both the schema
// and the runtime have to read it. Before this, `number` accepted no arguments
// at all, adopt dropped the bound and an adopted contract accepted values its
// source rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { adoptOpenapi } from '../src/adopt.ts';
import { startService } from './harness.ts';

const source = [
  'module demo @0.1.0 {',
  '}',
  '',
  'service Prices : http {',
  '  contract {',
  '    public op page(price: number(min: 0.5, max: 99.5)) -> { price: number } {',
  '      route: "GET /v1/price"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const impl = 'export async function page(input) { return { result: { price: Number(input.price) } }; }';

test('a real bound reaches the OpenAPI parameter unchanged', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const param = (doc.paths as any)['/v1/price'].get.parameters[0];
  assert.deepEqual(param.schema, { type: 'number', minimum: 0.5, maximum: 99.5 });
});

test('float takes the same bounds', () => {
  const src = [
    'module m @0.1.0 {',
    '}',
    '',
    'service Rates : http {',
    '  contract {',
    '    public op read(rate: float(min: 0.1)) -> { rate: float } {',
    '      route: "GET /v1/rate"',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const doc = emitOpenapi(parse(src, 'x.arc'));
  const param = (doc.paths as any)['/v1/rate'].get.parameters[0];
  assert.deepEqual(param.schema, { type: 'number', minimum: 0.1 });
});

test('a default outside a real bound is A060', () => {
  const a060 = (field: string) => check(parse('module m @0.1.0 {\n}\ntype Item = { ' + field + ' }', 'x.arc'))
    .filter((diag) => diag.code === 'A060');
  const low = a060('price: number(min: 0.5) = 0.1');
  assert.equal(low.length, 1);
  assert.match(low[0].message, /must be >= 0.5/);
  assert.deepEqual(a060('price: number(min: 0.5) = 0.75'), []);
});

test('the service keeps fractions inside a real bound and rejects the rest', async () => {
  assert.deepEqual(check(parse(source, 'main.arc')).filter((item) => item.severity === 'error'), []);
  const svc = await startService(source, { impl: { page: impl } });
  try {
    const ok = await fetch(svc.base + '/v1/price?price=0.75');
    assert.equal(ok.status, 200);
    const low = await fetch(svc.base + '/v1/price?price=0.4');
    assert.equal(low.status, 400);
    assert.match(await low.text(), /must be >= 0.5/);
    const high = await fetch(svc.base + '/v1/price?price=100');
    assert.equal(high.status, 400);
    assert.match(await high.text(), /must be <= 99.5/);
    const nan = await fetch(svc.base + '/v1/price?price=abc');
    assert.equal(nan.status, 400);
    assert.match(await nan.text(), /must be a number/);
  } finally {
    await svc.stop();
  }
});

test('an integer bound still rejects a fraction', async () => {
  const intSource = [
    'module demo @0.1.0 {',
    '}',
    '',
    'service Items : http {',
    '  contract {',
    '    public op page(limit: int(min: 1, max: 10)) -> { limit: int } {',
    '      route: "GET /v1/items"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const svc = await startService(intSource, { impl: { page: 'export async function page(input) { return { result: { limit: Number(input.limit) } }; }' } });
  try {
    const half = await fetch(svc.base + '/v1/items?limit=1.5');
    assert.equal(half.status, 400);
    assert.match(await half.text(), /must be an integer/);
  } finally {
    await svc.stop();
  }
});

function docWith(schema: Record<string, unknown>) {
  return {
    openapi: '3.0.3',
    info: { title: 'Prices', version: '1' },
    paths: {
      '/prices': {
        get: {
          operationId: 'listPrices',
          parameters: [{ name: 'price', in: 'query', schema: { type: 'number', ...schema } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: { schemas: {} },
  };
}

function adopted(schema: Record<string, unknown>) {
  const out = adoptOpenapi(docWith(schema));
  assert.deepEqual(check(parse(out, 'main.arc')).filter((diag) => diag.severity === 'error'), []);
  return out;
}

test('adopt keeps an inclusive real bound', () => {
  const out = adopted({ minimum: 0.5, maximum: 99.5 });
  assert.match(out, /price: number\(min: 0\.5, max: 99\.5\)/);
});

test('adopt makes an exclusive real bound the next representable value', () => {
  const out = adopted({ exclusiveMinimum: 1.5 });
  assert.match(out, /price: number\(min: 1\.5000000000000002\)/);
  const binary = adopted({ minimum: 1.5, exclusiveMinimum: true });
  assert.match(binary, /price: number\(min: 1\.5000000000000002\)/);
});
