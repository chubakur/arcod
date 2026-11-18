// A path copied from an OpenAPI document spells a capture `{id}`. Arcod spells
// it `:id`, so without a check the route is a literal segment with braces: the
// parameter is never bound and the operation answers 404 for every real id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

const spec = (route: string): string => `module braces @0.1.0 {}

service Items : http {
  contract {
    public op read(id: uuid) -> string {
      route: "${route}"
    }
  }
}
`;

test('A075: an OpenAPI-style capture is refused with the arcod spelling', () => {
  const diags = check(parse(spec('GET /v1/items/{id}'), 'braces.arc')).filter((d) => d.code === 'A075');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.match(diags[0].message, /\{id\}/);
  assert.match(diags[0].hint ?? '', /write :id/);
});

test('A075: the arcod spelling is clean and binds the parameter', () => {
  const diags = check(parse(spec('GET /v1/items/:id'), 'braces.arc'));
  assert.deepEqual(diags.filter((d) => d.code === 'A075'), []);
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), []);
});
