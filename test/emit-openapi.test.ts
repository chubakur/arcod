import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse, ParseError } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService, pickService, routeOf, statusForError } from '../src/emit/service.ts';
import { checksumOf, migrationPlan } from '../src/migrate.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml, nginxConf } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { deployManifest } from '../src/deploy.ts';
import { providersForCapability } from '../src/providers.ts';
import { runExamples } from '../src/test.ts';
import { runPipeline } from '../src/pipeline.ts';
import { buildPrompts } from '../src/prompts.ts';
import { planBody } from '../src/plan-body.ts';
import { extractCode, validateBody, sandboxViolation } from '../src/impl.ts';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specUrl = new URL('../examples/onetimemessage/main.arc', import.meta.url);
const source = await readFile(specUrl, 'utf8');
const ast = parse(source, 'main.arc');

const mysqlUrl = new URL('../examples/project1-mysql/main.arc', import.meta.url);
const mysqlAst = parse(await readFile(mysqlUrl, 'utf8'), 'main.arc');

const filesUrl = new URL('../examples/files/main.arc', import.meta.url);
const filesAst = parse(await readFile(filesUrl, 'utf8'), 'main.arc');

// --- OpenAPI emitter (M0.1) ---

const EXAMPLE_SPECS = ['onetimemessage', 'onetimemessage-pwd', 'project1', 'project1-mysql', 'payments', 'files', 'quiz', 'chat'];

async function loadExample(name: string) {
  const url = new URL('../examples/' + name + '/main.arc', import.meta.url);
  return parse(await readFile(url, 'utf8'), 'main.arc');
}

test('openapi emits a valid document for every example', async () => {
  for (const name of EXAMPLE_SPECS) {
    const mod = await loadExample(name);
    const doc = emitOpenapi(mod);
    assert.equal(doc.openapi, '3.1.0', name);
    assert.equal((doc.info as Record<string, unknown>).title, mod.name, name);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    assert.ok(Object.keys(paths).length > 0, name + ' has no paths');
    for (const [path, item] of Object.entries(paths)) {
      assert.ok(path.startsWith('/'), name + ': path ' + path);
      for (const [method, op] of Object.entries(item)) {
        assert.match(method, /^(get|post|put|patch|delete)$/, name + ': ' + method);
        assert.match((op as Record<string, unknown>).operationId as string, /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/, name);
      }
    }
    // every $ref resolves inside the document
    const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
    const refs: string[] = [];
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(walk);
      for (const [key, entry] of Object.entries(value)) {
        if (key === '$ref') refs.push(entry as string);
        else walk(entry);
      }
    };
    walk(doc);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/components/schemas/'), name + ': external ref ' + ref);
      assert.ok(schemas[ref.slice('#/components/schemas/'.length)], name + ': unresolved ref ' + ref);
    }
  }
});

test('openapi: changing a type changes the schema', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const schemas = (doc.components as Record<string, unknown>).schemas as Record<string, unknown>;
  assert.deepEqual(schemas.Body, { type: 'string', minLength: 1, maxLength: 65536 });

  const changed = parse(source.replace('max: 64kb', 'max: 1kb'), 'main.arc');
  const changedDoc = emitOpenapi(changed);
  const changedSchemas = (changedDoc.components as Record<string, unknown>).schemas as Record<string, unknown>;
  assert.deepEqual(changedSchemas.Body, { type: 'string', minLength: 1, maxLength: 1024 });
  assert.notDeepEqual(schemas.Body, changedSchemas.Body);
});

test('openapi: changing a route changes the path', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const paths = doc.paths as Record<string, unknown>;
  assert.ok(paths['/api/messages']);
  assert.ok(paths['/api/messages/{id}']);

  const changed = parse(source.replace('GET /api/messages/:id', 'GET /v2/messages/:id'), 'main.arc');
  const changedPaths = emitOpenapi(changed).paths as Record<string, unknown>;
  assert.ok(!changedPaths['/api/messages/{id}']);
  assert.ok(changedPaths['/v2/messages/{id}']);
});

test('openapi: error mapping is preserved', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const read = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/messages/{id}'].get;
  const responses = read.responses as Record<string, unknown>;
  assert.ok(responses['404'], 'NotFound mapped to 404');
  assert.ok(responses['410'], 'Gone mapped to 410');
  const notFound = responses['404'] as Record<string, unknown>;
  const schema = (notFound.content as Record<string, Record<string, unknown>>)['application/json'].schema as Record<string, unknown>;
  assert.equal(((schema.properties as Record<string, unknown>).error as Record<string, unknown>).const, 'NotFound');

  // and matches the runtime mapping used by the HTTP emitter
  const files = await loadExample('files');
  const filesDoc = emitOpenapi(files);
  const download = (filesDoc.paths as Record<string, Record<string, Record<string, unknown>>>)['/v1/files/{id}'].get;
  const downloadResponses = download.responses as Record<string, unknown>;
  assert.ok(downloadResponses[String(statusForError('Unauthorized'))]);
  assert.ok(downloadResponses[String(statusForError('NotFound'))]);
});

test('openapi: operationIds are stable <service>.<op>', async () => {
  const mod = await loadExample('files');
  const doc = emitOpenapi(mod);
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  const ids = Object.values(paths).flatMap((item) => Object.values(item).map((op) => (op as Record<string, unknown>).operationId));
  assert.ok(ids.includes('FileShare.upload'));
  assert.ok(ids.includes('FileShare.download'));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
});

test('openapi: examples are exported from the examples block', async () => {
  const mod = await loadExample('onetimemessage');
  const doc = emitOpenapi(mod);
  const create = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/messages'].post;
  const opExamples = create.examples as Record<string, Record<string, unknown>>;
  assert.deepEqual(opExamples.create_and_read.value, { body: 'hi' });
  const badRequest = (create.responses as Record<string, Record<string, unknown>>)['400'];
  const media = (badRequest.content as Record<string, Record<string, unknown>>)['application/json'];
  const errorExamples = media.examples as Record<string, Record<string, unknown>>;
  assert.deepEqual(errorExamples.rejects_empty.value, { error: 'Invalid' });
});

test('openapi: a public operation without a route is rejected (A050)', async () => {
  const broken = parse(source.replace('route: "GET /api/messages/:id"', ''), 'main.arc');
  const diags = check(broken);
  assert.ok(diags.some((d) => d.code === 'A050' && d.severity === 'error'));
  assert.ok(diags.find((d) => d.code === 'A050')?.message.includes('read'));
  // clean specs stay clean
  assert.ok(!check(ast).some((d) => d.code === 'A050'));
});

test('openapi: an external service contract can be exported on its own', async () => {
  const mod = await loadExample('payments');
  const doc = emitOpenapi(mod, { service: 'Ledger' });
  const ledger = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)['/v1/entries'].post;
  assert.equal(ledger.operationId, 'Ledger.record');
  const body = (ledger.requestBody as Record<string, Record<string, Record<string, unknown>>>) ?? null;
  assert.ok(body);
  // the local service is not part of the external contract
  assert.ok(!(doc.paths as Record<string, unknown>)['/v1/orders']);
});
