import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { printModule, formatSource } from '../src/fmt.ts';
import { diffSpecs } from '../src/diff.ts';
import { adoptOpenapi } from '../src/adopt.ts';
import { LANG_VERSION, migrateSpec, VersionError } from '../src/versions.ts';

function strip(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === 'loc' || k === 'source' || k === 'file' ? undefined : v)));
}

const EXAMPLES = [
  'onetimemessage', 'onetimemessage-pwd', 'tasks', 'tasks-sql', 'orders',
  'saga', 'payments', 'files', 'chat', 'quiz', 'project1', 'project1-mysql',
];

for (const name of EXAMPLES) {
  test('fmt round-trips example ' + name, async () => {
    const url = new URL('../examples/' + name + '/main.arc', import.meta.url);
    const src = await readFile(url, 'utf8');
    const a = strip(parse(src, 'main.arc'));
    const printed = printModule(parse(src, 'main.arc'));
    const b = strip(parse(printed, 'main.arc'));
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'AST must survive parse -> print -> parse');
    assert.equal(printModule(parse(printed, 'main.arc')), printed, 'fmt must be idempotent');
  });
}

test('fmt is idempotent on the canonical form', () => {
  const src = 'module m @0.1.0 { }\n';
  const once = printModule(parse(src, 'main.arc'));
  assert.equal(printModule(parse(once, 'main.arc')), once);
});

test('fmt preserves comments attached to declarations', async () => {
  const url = new URL('../examples/tasks/main.arc', import.meta.url);
  const src = await readFile(url, 'utf8');
  const out = formatSource(src, 'main.arc');
  assert.match(out, /A title is the human key of a task/);
  assert.match(out, /module tasks @0.1.0/);
});

test('fmt normalizes whitespace and record layout', () => {
  const messy = 'module m @0.1.0{meta{owner:"a"}}\ntype T={x:string,y:int?}\n';
  const out = printModule(parse(messy, 'main.arc'));
  assert.match(out, /module m @0.1.0 \{\n  meta \{/);
  assert.match(out, /type T = \{ x: string, y: int\? \}/);
});

test('diff reports semantic changes, not formatting noise', () => {
  const a = 'module m @0.1.0 { }\ntype T = { x: string }\n';
  const b = 'module m @0.1.0 { }\ntype T = { x: string, y: int }\n';
  const out = diffSpecs(a, 'a.arc', b, 'b.arc');
  assert.match(out, /^--- a\.arc/m);
  assert.match(out, /^\+\+\+ b\.arc/m);
  assert.match(out, /^-type T = \{ x: string \}$/m);
  assert.match(out, /^\+type T = \{ x: string, y: int \}$/m);
});

test('diff of identical specs is empty apart from headers', () => {
  const src = 'module m @0.1.0 { }\ntype T = { x: string }\n';
  const out = diffSpecs(src, 'a.arc', src, 'b.arc');
  assert.match(out, /^--- a\.arc/m);
  const body = out.split('\n').slice(2).join('\n');
  assert.doesNotMatch(body, /^[+-]/m);
});

test('adopt turns an OpenAPI document into a spec', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } },
        },
      },
    },
    components: { schemas: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { type: 'string' } } } } },
  };
  const out = adoptOpenapi(doc);
  const mod = parse(out, 'main.arc');
  assert.equal(mod.name, 'Pets');
  assert.equal(mod.services.length, 1);
  const op = mod.services[0].contract[0];
  assert.equal(op.name, 'listPets');
  assert.equal(op.isPublic, true);
  assert.equal(op.returns?.kind, 'named');
  assert.match(out, /route: "GET \/pets"/);
  assert.match(out, /type Pet = \{ name: string, tag: string\? \}/);
});

test('adopt maps enums to enum declarations', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'S', version: '1' },
    paths: {},
    components: { schemas: { Status: { type: 'string', enum: ['open', 'closed'] } } },
  };
  const out = adoptOpenapi(doc);
  assert.match(out, /enum Status \{ open, closed \}/);
  assert.doesNotMatch(out, /type Status = Status/);
});

test('spec migration is identity at the only version', () => {
  const src = 'module m @0.1.0 { }\n';
  assert.equal(migrateSpec(src, '0.1.0', '0.1.0'), src);
});

test('spec migration rejects unknown versions', () => {
  assert.throws(() => migrateSpec('x', '9.9.9', LANG_VERSION), VersionError);
  assert.throws(() => migrateSpec('x', '0.1.0', '9.9.9'), VersionError);
  assert.throws(() => migrateSpec('x', '0.1.0', '0.0.0'), VersionError);
});
