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

function a087(body: string): ReturnType<typeof check> {
  return check(moduleOf(body)).filter((item) => item.code === 'A087');
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

test('a misspelled string argument is A087, not a dropped bound', () => {
  const diags = a087('type Account = { name: string(mx: 80) }');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'error');
  assert.match(diags[0].message, /unknown argument "mx" for string/);
  assert.match(diags[0].hint ?? '', /min, max, format/);
});

test('a builtin with no argument readers rejects any argument', () => {
  const diags = a087('type Account = { active: bool(max: 5) }');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /bool takes no arguments/);
});

test('list and map count their type arguments', () => {
  const list = a087('type Item = { id: uuid }\ntype Page = { items: list<Item, Item> }');
  assert.equal(list.length, 1);
  assert.match(list[0].message, /list takes 1 type argument, got 2/);
  const map = a087('type Page = { byId: map<uuid> }');
  assert.equal(map.length, 1);
  assert.match(map[0].message, /map takes 2 type arguments, got 1/);
});

test('the documented argument sets stay clean', () => {
  const diags = a087('type Item = { id: uuid }\ntype Account = { name: string(min: 1, max: 80, format: email), photo: bytes(max: 2mb), age: int(min: 0, max: 150) }\ntype Page = { items: list<Item>, byId: map<uuid, Item> }');
  assert.deepEqual(diags, []);
});
