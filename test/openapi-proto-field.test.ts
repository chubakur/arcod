// The OpenAPI document is a published contract, and its maps were written
// through an index. A record field or component named __proto__ set the
// prototype of the map instead of adding a key, so the field disappeared from
// the schema the clients read while the runtime still required it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';

const source = [
  'module o @0.1.0 {}',
  'type Weird = { id: uuid, __proto__: string, toString: string }',
  'service O : http {',
  '  contract {',
  '    public op get(id: uuid) -> Weird { route: "GET /v1/w" }',
  '  }',
  '}',
].join('\n');

test('a __proto__ field stays a published property', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const published = JSON.parse(JSON.stringify(doc));
  const weird = published.components.schemas.Weird;
  assert.deepEqual(Object.keys(weird.properties).sort(), ['__proto__', 'id', 'toString']);
  assert.equal(weird.properties.__proto__.type, 'string');
  assert.ok(weird.required.includes('__proto__'), 'the field is still required');
  assert.ok(weird.required.includes('toString'));
});

test('the document itself has no prototype pollution', () => {
  const doc = emitOpenapi(parse(source, 'main.arc'));
  const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
  assert.equal(Object.getPrototypeOf(schemas), Object.prototype, 'the schema map keeps its prototype');
  assert.equal(({} as Record<string, unknown>).type, undefined, 'Object.prototype is untouched');
});
