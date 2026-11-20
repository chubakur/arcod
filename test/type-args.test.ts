// A086 — arguments refine a builtin name. `string(max: 80)` is a fact about
// the scalar; written on a declared type the arguments were dropped: check
// stayed silent, OpenAPI emitted `$ref Title` and `min: 3` reached neither the
// schema nor the runtime. The resolver always follows the alias to its
// declaration, so the only legal place for arguments is that declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

function moduleOf(body: string): ReturnType<typeof parse> {
  return parse('module m @0.1.0 {\n}\n\n' + body + '\n', 'types.arc');
}

function a086(body: string): ReturnType<typeof check> {
  return check(moduleOf(body)).filter((item) => item.code === 'A086');
}

const title = 'type Title = string(max: 80)\n';

test('arguments on a declared type are A086, not silently dropped', () => {
  const diags = a086(title + 'type Account = { name: Title(min: 3) }');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].path, 'types.Title');
  assert.match(diags[0].message, /Title\(min: 3\)|arguments on Title are ignored/);
  assert.match(diags[0].hint ?? '', /type Title = string\(min: …\)/);
});

test('an alias declared with arguments is A086 too', () => {
  const diags = a086(title + 'type Short = Title(min: 5)');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /declared type, not a builtin/);
});

test('an enum takes no arguments either', () => {
  const diags = a086('enum Plan { free, pro }\ntype Account = { plan: Plan(max: 5) }');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Plan/);
});

test('a parameter, its return and a nested list all report the call site', () => {
  const body = title + [
    'type Item = { id: uuid }',
    'service Items : http {',
    '  contract {',
    '    public op read(name: Title(min: 2)) -> list<Title(max: 4)> {',
    '      route: "GET /v1/items"',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const diags = a086(body);
  assert.equal(diags.length, 2, diags.map((item) => item.message).join('; '));
  assert.deepEqual(diags.map((item) => item.range.line).sort((a, b) => a - b), [8, 8]);
});

test('the same fact written where the builtin is declared is clean', () => {
  const diags = a086(title + 'type Account = { name: Title, bio: string(max: 200) }');
  assert.deepEqual(diags, []);
});

test('builtin generic arguments are not mistaken for refinements', () => {
  const diags = a086('type Item = { id: uuid }\ntype Page = { items: list<Item> }');
  assert.deepEqual(diags, []);
});
