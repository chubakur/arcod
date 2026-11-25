// The GraphQL scalar table is keyed by a model type name. A field typed as an
// undeclared `toString` answered Object.prototype.toString, so the schema
// carried that function's source text as the field type and registered it as a
// custom scalar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { graphqlSchema } from '../src/emit/graphql.ts';

const source = [
  'module g @0.1.0 {}',
  'type Box = { id: uuid, value: toString, other: constructor }',
  'service G : http {',
  '  contract {',
  '    public op get(id: uuid) -> Box { route: "GET /v1/box" }',
  '  }',
  '}',
].join('\n');

test('an undeclared type named like a prototype member is the JSON hole', () => {
  const sdl = graphqlSchema(parse(source, 'main.arc'));
  assert.doesNotMatch(sdl, /native code|function toString|function constructor/, 'no function source in the SDL');
  assert.match(sdl, /value: JSON/, 'the value field falls through to JSON');
  assert.match(sdl, /id: ID/, 'real scalars are untouched');
});

test('a declared scalar position is not registered as a custom scalar', () => {
  const sdl = graphqlSchema(parse(source, 'main.arc'));
  assert.doesNotMatch(sdl, /scalar toString\b/);
});
