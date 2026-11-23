import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';

// A route without a body has one value per parameter name on the wire. The
// service reads searchParams.get(name) and the harness sends String(value), so
// a list arrived as the string "a" (second value lost) while the contract
// promised list<string>: check was clean and the body did its own parsing.
// A095 refuses the parameter instead of shipping the mismatch.

function moduleWith(contract: string, types = ''): string {
  return [
    'module q @0.1.0 {',
    '  meta { title: "query shapes" }',
    '}',
    types,
    'service Notes : http {',
    '  contract {',
    contract,
    '  }',
    '}',
    '',
    'environment dev {',
    '  deploy docker',
    '}',
  ].join('\n');
}

function codes(source: string, code: string): string[] {
  const mod = parse(source, 'main.arc');
  return check(mod)
    .filter((entry) => entry.code === code)
    .map((entry) => entry.path ?? '');
}

test('A095: a list or map on a bodyless route is refused', () => {
  const source = moduleWith([
    '    public op listq(tag: list<string>) -> string { route: "GET /v1/tags" }',
    '    public op mapq(filter: map<string, string>) -> string { route: "HEAD /v1/tags" }',
    '    public op delq(ids: list<uuid>) -> string { route: "DELETE /v1/tags" }',
    '    public op optq(tags: list<string>?) -> string { route: "GET /v1/opt" }',
  ].join('\n'));
  assert.deepEqual(codes(source, 'A095').sort(), [
    'services.Notes.contract.delq.ids',
    'services.Notes.contract.listq.tag',
    'services.Notes.contract.mapq.filter',
    'services.Notes.contract.optq.tags',
  ]);
});

test('A095: an alias of a list is the same shape', () => {
  const source = moduleWith(
    '    public op alias(al: Tags) -> string { route: "GET /v1/al" }',
    'type Tags = list<string>\n',
  );
  assert.deepEqual(codes(source, 'A095'), ['services.Notes.contract.alias.al']);
});

test('A095: scalars and POST bodies stay clean, a list next to a capture does not', () => {
  const source = moduleWith([
    '    public op scalar(tag: string, limit: int) -> string { route: "GET /v1/ok" }',
    '    public op posted(tags: list<string>) -> string { route: "POST /v1/tags" }',
    '    public op captured(id: uuid, tags: list<string>) -> string { route: "GET /v1/x/:id" }',
  ].join('\n'));
  // Only the capture comes from the path; `tags` is still a query parameter.
  assert.deepEqual(codes(source, 'A095'), ['services.Notes.contract.captured.tags']);
});
