// A name that is neither a builtin nor declared used to be accepted as an
// opaque type: OpenAPI emitted `{}`, so a typo widened the contract to accept
// any value, and GraphQL had no field type at all. A typo is now A088 at its
// own call site, with the declaration that would fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function moduleOf(body: string): ReturnType<typeof parse> {
  return parse('module m @0.1.0 {\n}\n\n' + body + '\n', 'types.arc');
}

function a088(body: string): ReturnType<typeof check> {
  return check(moduleOf(body)).filter((item) => item.code === 'A088');
}

test('an undeclared field type is A088 with a declaration hint', () => {
  const diags = a088('type Account = { name: Bogus }');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'types.Bogus');
  assert.match(diags[0].message, /unknown type Bogus/);
  assert.match(diags[0].hint ?? '', /declare type Bogus = … or use a builtin/);
});

test('an alias to a missing name is A088 too', () => {
  const diags = a088('type Short = Missing');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /unknown type Missing/);
});

test('a parameter, a return and a nested list each report their site', () => {
  const body = [
    'service Items : http {',
    '  contract {',
    '    public op read(name: Bogus) -> list<Absent> {',
    '      route: "GET /v1/items"',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const diags = a088(body);
  assert.equal(diags.length, 2, diags.map((item) => item.message).join('; '));
  assert.deepEqual(diags.map((item) => item.message).sort(), ['unknown type Absent', 'unknown type Bogus']);
});

test('a workflow port is a type position too', () => {
  const body = [
    'service S : http {',
    '  contract { op list() -> int { route: "GET /l" } }',
    '}',
    'workflow W {',
    '  trigger manual',
    '  step one(input: Bogus) -> Absent {',
    '    call: S.list',
    '  }',
    '}',
  ].join('\n');
  const diags = a088(body);
  assert.equal(diags.length, 2, diags.map((item) => item.message).join('; '));
  assert.deepEqual(diags.map((item) => item.message).sort(), ['unknown type Absent', 'unknown type Bogus']);
});

test('declaration order does not matter', () => {
  const diags = a088('type A = { b: B }\ntype B = { id: uuid }');
  assert.deepEqual(diags, []);
});

test('builtins, enums and declared types are clean', () => {
  const body = [
    'enum Plan { free, pro }',
    'type Item = { id: uuid, plan: Plan, tags: list<string>, meta: map<string, int>, at: datetime? }',
    'type Page = { items: list<Item>, next: string? }',
  ].join('\n');
  assert.deepEqual(a088(body), []);
});
