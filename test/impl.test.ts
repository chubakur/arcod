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

test('dead keywords are rejected, not silently ignored', () => {
  const base = 'module m @0.1.0 { meta { } }\n';
  const cases: Array<[string, string]> = [
    ['change', base + 'change X { }'],
    ['policy', base + 'policy P { }'],
    ['unknown', base + 'unknown X { }'],
    ['hint', base + 'service S : http { contract { public op a() -> string { route: \"GET /a\" } } hint H { } }'],
    ['impl', base + 'service S : http { impl { } contract { public op a() -> string { route: \"GET /a\" } } }'],
    ['lifecycle', base + 'service S : http { lifecycle { } contract { public op a() -> string { route: \"GET /a\" } } }'],
    ['idempotent', base + 'service S : http { contract { public op a() -> string { route: \"GET /a\" idempotent } } }'],
    ['schedule', base + 'service S : http { contract { public op a() -> string { route: \"GET /a\" schedule: \"* * * * *\" } } }'],
    ['since', base + 'service S : http { contract { public op a() -> string { route: \"GET /a\" since: \"2020\" } } }'],
  ];
  for (const [name, src] of cases) {
    assert.throws(() => parse(src, 'main.arc'), /not supported in v0\.1/, name + ' must be rejected');
  }
});

test('module meta since stays legal', () => {
  const mod = parse('module m @0.1.0 { meta { owner: \"@x\" status: draft since: \"2026-11-11\" } }', 'main.arc');
  assert.equal(mod.meta.since, '2026-11-11');
});

test('the body sandbox blocks network, fs, exec, process and eval', () => {
  const block: Array<[string, RegExp]> = [
    ['fetch(\"https://x\")', /network/],
    ['import fs from \"fs\"', /import/],
    ['require(\"fs\")', /require/],
    ['fs.readFileSync(\"x\")', /filesystem/],
    ['child_process.exec(\"x\")', /processes/],
    ['execSync(\"x\")', /processes/],
    ['process.exit(1)', /process/],
    ['process.env.SECRET', /environment/],
    ['eval(\"x\")', /eval/],
    ['new Function(\"x\")', /Function/],
  ];
  for (const [src, re] of block) assert.match(sandboxViolation(src) ?? '', re, src);
  assert.equal(sandboxViolation('export async function a(input, io) { return { result: 1 }; }'), null);
});

test('a hand-written impl body that violates the sandbox fails the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-sandbox-'));
  const sagaUrl = new URL('../examples/saga/main.arc', import.meta.url);
  const sagaAst = parse(await readFile(sagaUrl, 'utf8'), 'main.arc');
  const implDir = join(dir, 'impl');
  await mkdir(implDir, { recursive: true });
  await writeFile(join(implDir, 'mark.mjs'), 'export async function mark(input, io) { return { result: process.exit(1) }; }');
  await assert.rejects(() => buildExample(sagaAst, dir, { implDir }), /violates the sandbox/);
});

test('build emits an impl-manifest with body hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-manifest-'));
  const sagaUrl = new URL('../examples/saga/main.arc', import.meta.url);
  const sagaAst = parse(await readFile(sagaUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/saga/impl', import.meta.url));
  const built = await buildExample(sagaAst, dir, { implDir });
  const manifest = JSON.parse(await readFile(join(built.dir, 'impl-manifest.json'), 'utf8'));
  assert.equal(manifest.mode, 'impl');
  assert.ok(manifest.bodies.mark, 'mark is in the manifest');
  assert.match(manifest.bodies.mark.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.bodies.mark.bytes > 0);
  assert.equal(manifest.bodies.mark.source, 'impl');
});

test('malformed specs throw instead of hanging the parser', () => {
  // The LSP feeds every keystroke to the parser, so an unclosed brace or a
  // stray token must throw a ParseError, never spin forever.
  const cases = [
    'module demo @0.1.0 {\n  type = =\n',
    'module demo @0.1.0 {',
    'module demo @0.1.0 { meta {',
    'module demo @0.1.0 {\n',
    'service X : http {',
    'type = =',
    'module',
    '',
    'module demo @0.1.0 { } service',
  ];
  for (const source of cases) {
    assert.throws(() => parse(source, 'broken.arc'), ParseError, 'input: ' + JSON.stringify(source));
  }
});




