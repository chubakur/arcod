import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

// The CLI is the only surface a user actually touches. These tests drive
// main() in-process and assert the contract: a message on the right stream and
// an exit code, never an uncaught stack trace. Commands that write the payload
// to stdout run as a child process, because the test reporter owns this
// process's stdout. Nothing in the repo is rewritten: every case works on a
// temp copy of a real example.

const signupUrl = new URL('../examples/signup/main.arc', import.meta.url);
const tasksUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);
const signup = await readFile(signupUrl, 'utf8');

interface Result {
  out: string;
  err: string;
  code: number;
}

// console.log is the only stream main() uses for non-payload output, so a
// straightforward swap is enough here.
async function run(argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

// Real process, real exit status, real stdout: used where the payload goes
// straight to stdout and the exit code is part of the contract.
function runChild(argv: string[]): Result {
  const r = spawnSync(process.execPath, ['bin/arcod.mjs', ...argv], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

async function tempDir(prefix = 'arcod-cli-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test('help and version answer without a spec', async () => {
  const bare = await run([]);
  assert.equal(bare.code, 0);
  assert.match(bare.out, /usage:/);
  assert.match(bare.out, /arcod 0\.1\.0/);

  const flagged = await run(['--help']);
  assert.equal(flagged.code, 0);
  assert.equal(flagged.out, bare.out);

  for (const argv of [['version'], ['--version'], ['-v']]) {
    const r = await run(argv);
    assert.equal(r.code, 0, argv.join(' '));
    assert.equal(r.out.trim(), '0.1.0');
  }
});

test('an unknown command prints help and exits 2', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command: frobnicate/);
  assert.match(r.out + r.err, /usage:/);
});

test('an unknown flag is a usage error, not a crash', async () => {
  const r = await run(['check', '--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.err, /arcod: unknown flag: --bogus/);
  assert.match(r.err, /arcod help/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace leaks to the user');
});

test('check says nothing on a clean spec and prints diagnostics as JSON', async () => {
  const quiet = await run(['check', signupUrl.pathname]);
  assert.equal(quiet.code, 0);
  assert.doesNotMatch(quiet.out, /\s+error\s+/, 'the example has no errors');

  const json = await run(['check', signupUrl.pathname, '--json']);
  assert.equal(json.code, 0);
  const diags = JSON.parse(json.out) as Array<{ severity: string }>;
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), []);
});

test('check fails a broken spec with file:line:col and a parse hint', async () => {
  const dir = await tempDir();
  const file = join(dir, 'broken.arc');
  await writeFile(file, 'module broken @0.1.0 {\n  service {\n', 'utf8');
  const r = await run(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /broken\.arc:\d+:\d+ +error +parse/);
});

test('check explains a directory that holds no spec', async () => {
  const dir = await tempDir();
  const r = await run(['check', dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no \.arc file found/);
});

test('load prefers main.arc and falls back to a spec/ directory', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'a.arc'), signup, 'utf8');
  await writeFile(join(dir, 'main.arc'), signup, 'utf8');
  const preferred = await run(['ast', dir]);
  assert.equal(preferred.code, 0, JSON.stringify(preferred.err));

  const nested = await tempDir();
  await mkdir(join(nested, 'spec'));
  await writeFile(join(nested, 'spec', 'z.arc'), signup, 'utf8');
  const viaSpecDir = await run(['ast', nested]);
  assert.equal(viaSpecDir.code, 0, JSON.stringify(viaSpecDir.err));
  assert.equal(JSON.parse(viaSpecDir.out).version, '0.1.0');
});

test('ast prints the module without the source and gates on --check', async () => {
  const plain = await run(['ast', signupUrl.pathname]);
  assert.equal(plain.code, 0);
  const ast = JSON.parse(plain.out);
  assert.equal(ast.version, '0.1.0');
  assert.equal('source' in ast, false);
  assert.ok(Array.isArray(ast.services));

  const dir = await tempDir();
  const file = join(dir, 'broken.arc');
  await writeFile(file, 'module x @0.1.0 {\n  service {\n', 'utf8');
  const gated = await run(['ast', file, '--check']);
  assert.equal(gated.code, 1);
  assert.equal(gated.out.trim(), '', 'nothing is printed when the gate trips');
});

test('fmt --check separates formatted from not and --write persists', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  await writeFile(file, signup, 'utf8');

  const written = await run(['fmt', file, '--write']);
  assert.equal(written.code, 0, JSON.stringify(written.err));
  assert.match(written.out, /formatted /);
  const formatted = await readFile(file, 'utf8');

  const ok = await run(['fmt', file, '--check']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /: ok$/);

  await writeFile(file, formatted + '\n\n\n', 'utf8');
  const drifted = await run(['fmt', file, '--check']);
  assert.equal(drifted.code, 1);
  assert.match(drifted.out, /: not formatted$/);

  const toStdout = runChild(['fmt', file]);
  assert.equal(toStdout.code, 0, toStdout.err);
  assert.match(toStdout.out, /module signup/);
});

test('fmt --to an unsupported version refuses instead of guessing', async () => {
  const r = await run(['fmt', signupUrl.pathname, '--to', '0.0.1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown target version 0\.0\.1/);
  assert.match(r.err, /supported: 0\.1\.0/);
});

test('diff and adopt insist on their positional arguments', async () => {
  const diff = await run(['diff']);
  assert.equal(diff.code, 2);
  assert.match(diff.err, /usage: arcod diff/);

  const adopt = await run(['adopt']);
  assert.equal(adopt.code, 2);
  assert.match(adopt.err, /usage: arcod adopt/);
});

test('diff renders a real difference between two specs', () => {
  const r = runChild(['diff', signupUrl.pathname, tasksUrl.pathname]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.length > 0, 'two different specs produce output');
});

test('adopt rejects YAML with a pointer to JSON', async () => {
  const dir = await tempDir();
  const file = join(dir, 'openapi.yaml');
  await writeFile(file, 'openapi: 3.0.0\n', 'utf8');
  const r = await run(['adopt', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /only JSON OpenAPI documents/);
});

test('new validates the name and scaffolds into the current directory', async () => {
  const missing = await run(['new']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /usage: arcod new/);

  const bad = await run(['new', 'Bad Name']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /name must match/);

  const dir = await tempDir();
  const before = process.cwd();
  try {
    process.chdir(dir);
    const ok = await run(['new', 'demo-app']);
    assert.equal(ok.code, 0, JSON.stringify(ok.err));
    assert.match(ok.out, /^created /m);
    assert.match(ok.out, /next: cd demo-app/);
    const entries = await readdir(join(dir, 'demo-app'));
    assert.ok(entries.includes('main.arc'), 'scaffold writes the spec');

    const twice = await run(['new', 'demo-app']);
    assert.equal(twice.code, 1, 'an existing directory is a refusal, not a crash');
    assert.match(twice.err, /already exists and is not empty/);

    const forced = await run(['new', 'demo-app', '--force']);
    assert.equal(forced.code, 0, '--force overwrites on purpose');
  } finally {
    process.chdir(before);
  }
});

test('providers lists the built-in capabilities as rows', async () => {
  const r = await run(['providers']);
  assert.equal(r.code, 0);
  assert.match(r.out, /kv/);
  assert.match(r.out, /sql/);
});

test('every emitter is reachable through the CLI', async () => {
  const dir = await tempDir('arcod-cli-emit-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');
  const migrations = join(dir, '.arcod', 'build', 'migrations');

  const plan = await run(['plan', spec]);
  assert.equal(plan.code, 0, JSON.stringify(plan.err));
  assert.ok(plan.out.length > 0, 'plan prints the work ahead');

  const migrated = await run(['migrate', spec]);
  assert.equal(migrated.code, 0, JSON.stringify(migrated.err));
  assert.match(migrated.out, /artifact: \.arcod\/build\/migrations\//);
  const mysqlMigrations = JSON.parse(await readFile(join(migrations, 'changelog.json'), 'utf8')) as Array<{ up: string }>;
  assert.ok(mysqlMigrations.some((m) => m.up.includes('CREATE TABLE IF NOT EXISTS `')), 'mysql backticks identifiers');

  const postgres = await run(['migrate', spec, '--dialect', 'postgres']);
  assert.equal(postgres.code, 0, JSON.stringify(postgres.err));
  const postgresMigrations = JSON.parse(await readFile(join(migrations, 'changelog.json'), 'utf8')) as Array<{ up: string }>;
  assert.ok(postgresMigrations.some((m) => m.up.includes('CREATE TABLE IF NOT EXISTS "')), 'postgres quotes identifiers');
  assert.ok((await readdir(migrations)).some((name) => name.endsWith('.up.sql')), 'up/down files land on disk');

  const openapi = await run(['openapi', spec]);
  assert.equal(openapi.code, 0, JSON.stringify(openapi.err));
  assert.match(JSON.parse(openapi.out).openapi, /^3\./);

  const graphql = await run(['graphql', spec, '--out', 'schema.graphql']);
  assert.equal(graphql.code, 0, JSON.stringify(graphql.err));
  assert.match(await readFile(join(dir, 'schema.graphql'), 'utf8'), /type Query/);

  const grpc = await run(['grpc', spec, '--out', 'service.proto']);
  assert.equal(grpc.code, 0, JSON.stringify(grpc.err));
  assert.match(await readFile(join(dir, 'service.proto'), 'utf8'), /syntax = "proto3"/);

  const deploy = await run(['deploy', spec, '--env', 'prod', '--json']);
  assert.equal(deploy.code, 0, JSON.stringify(deploy.err));
  const manifest = JSON.parse(deploy.out);
  assert.ok(Object.keys(manifest.images).length > 0, 'the manifest carries the image contract');

  const k8s = await run(['k8s', spec, '--out', join(dir, 'out', 'k8s')]);
  assert.equal(k8s.code, 0, JSON.stringify(k8s.err));
  assert.match(k8s.out, /wrote \d+ file\(s\)/);
  assert.ok((await readdir(join(dir, 'out', 'k8s'))).length > 0);

  const terraform = await run(['terraform', spec, '--env', 'prod', '--out', join(dir, 'out', 'tf')]);
  assert.equal(terraform.code, 0, JSON.stringify(terraform.err));
  assert.match(await readFile(join(dir, 'out', 'tf', 'main.tf'), 'utf8'), /provider "yandex"/);
});

test('an emitter refuses a spec that does not check', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  // Parses, but names an error nobody declared: check owns that verdict, and
  // every emitter has to inherit it instead of rendering half a model.
  await writeFile(file, `module bad @0.1.0 {
  meta { owner: "@you" }
}

service Bad : http {
  contract {
    public op go() -> string {
      route: "GET /v1/go"
      errors: Missing
    }
  }
}
`, 'utf8');
  const checked = await run(['check', file]);
  assert.equal(checked.code, 1, 'the spec really is broken');
  const r = await run(['k8s', file]);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /error/);
});
