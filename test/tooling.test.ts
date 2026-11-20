import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { printModule, formatSource } from '../src/fmt.ts';
import { diffSpecs } from '../src/diff.ts';
import { adoptOpenapi } from '../src/adopt.ts';
import { LANG_VERSION, migrateSpec, VersionError, compareVersions } from '../src/versions.ts';
import { scaffold, isValidName, serviceName, moduleName } from '../src/new.ts';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function strip(x: unknown): unknown {
  // `clauseLocs`/`closeLoc`/`bodyLoc` are fmt anchors (positions only): a
  // canonical print moves them, so they are not part of the semantics this
  // test compares.
  return JSON.parse(JSON.stringify(x, (k, v) => (
    /locs?$/i.test(k) || k === 'blockCloses' || k === 'blockOpens' || k === 'source' || k === 'file' ? undefined : v
  )));
}

// Every directory under examples/ with a main.arc, not a hand-kept list: a
// new demo joins the round-trip check the moment it lands.
const examplesRoot = fileURLToPath(new URL('../examples', import.meta.url));
const EXAMPLES = (await readdir(examplesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

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

test('fmt keeps ui locale, locales and theme', () => {
  const src = [
    'module m @0.1.0 {}',
    'ui U {',
    '  title: "T"',
    '  locale: "ru"',
    '  locales: "en, ru"',
    '  theme: dark',
    '}',
  ].join('\n');
  const out = printModule(parse(src, 'main.arc'));
  assert.match(out, /locale: "ru"/);
  assert.match(out, /locales: "en, ru"/);
  assert.match(out, /theme: dark/);
  assert.equal(printModule(parse(out, 'main.arc')), out, 'fmt must be idempotent');
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

test('adopt keeps the constraints and formats the document declares', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'q', in: 'query', schema: { type: 'string', maxLength: 64 } },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', minLength: 1, maxLength: 80 },
            email: { type: 'string', format: 'email' },
            at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
  const out = adoptOpenapi(doc);
  assert.match(out, /id: uuid/);
  assert.match(out, /name: string\(min: 1, max: 80\)/);
  assert.match(out, /email: email/);
  assert.match(out, /at: datetime/);
  assert.match(out, /limit: int\(min: 1, max: 100\)\?/);
  assert.match(out, /q: string\(max: 64\)\?/);
  // The adopted module still checks clean: the mapped arguments are valid.
  const { check } = await import('../src/check.ts');
  const diags = check(parse(out, 'main.arc'));
  assert.equal(diags.filter((d) => d.severity === 'error').length, 0, diags.map((d) => d.code + ' ' + d.message).join('; '));
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

// A Swagger 2.0 document parses far enough to produce a plausible spec, but
// the prefix (basePath) and the models (definitions) would be dropped. Refuse
// it by name instead of silently adopting half a document.
test('adopt refuses Swagger 2.0 and unknown versions by name', () => {
  const swagger = { swagger: '2.0', info: { title: 'Pet', version: '1' }, basePath: '/v1', paths: {} };
  assert.throws(() => adoptOpenapi(swagger), /Swagger 2\.0.*OpenAPI 3/);

  assert.throws(() => adoptOpenapi({ info: { title: 'S' }, paths: {} }), /no "openapi" version field/);

  assert.throws(() => adoptOpenapi({ openapi: '4.0.0', info: { title: 'S' }, paths: {} }), /declares 4\.0\.0/);
});

test('adopt accepts every 3.x minor version', () => {
  for (const openapi of ['3.0.3', '3.1.0']) {
    const out = adoptOpenapi({ openapi, info: { title: 'S', version: '1' }, paths: {} });
    assert.match(out, /^module S @0\.1\.0/m);
  }
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


test('semver comparison orders versions', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('0.1.0', '0.2.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
});

test('arcod new names map slugs to valid identifiers', () => {
  assert.equal(isValidName('todo-list'), true);
  assert.equal(isValidName('Todo'), false);
  assert.equal(isValidName('-bad'), false);
  assert.equal(serviceName('todo-list'), 'TodoList');
  assert.equal(serviceName('my_app'), 'MyApp');
  assert.equal(moduleName('todo-list'), 'todo_list');
});

test('arcod new scaffolds a spec that parses and checks clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-new-'));
  try {
    const result = await scaffold('todo-list', dir);
    assert.deepEqual(result.files, ['main.arc', '.gitignore', 'impl/README.md']);
    const src = await readFile(join(dir, 'todo-list', 'main.arc'), 'utf8');
    assert.match(src, /module todo_list @0.1.0/);
    assert.match(src, /service TodoList : http/);
    const mod = parse(src, 'main.arc');
    assert.equal(mod.name, 'todo_list');
    // A generated file must already be canonical: `arcod fmt --check` on a
    // fresh project should not report the project's own spec.
    assert.equal(formatSource(src, 'main.arc'), src);
    const { check } = await import('../src/check.ts');
    // A fresh project must not greet its owner with warnings: every declared
    // error is handled and every operation has an example.
    const diags = check(mod);
    assert.equal(diags.length, 0, diags.map((e) => e.code + ' ' + e.message).join('; '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
