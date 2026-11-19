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
  assert.match(r.err, /hint: arcod check --help/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace leaks to the user');
});

test('every subcommand answers its own --help', async () => {
  const commands = ['check', 'ast', 'plan', 'openapi', 'graphql', 'grpc', 'migrate', 'fmt',
    'diff', 'adopt', 'upgrade', 'new', 'lsp', 'providers', 'deploy', 'terraform', 'k8s',
    'prompts', 'impl', 'make', 'build', 'test', 'run'];
  for (const command of commands) {
    const r = await run([command, '--help']);
    assert.equal(r.code, 0, command + ' --help exits 0');
    assert.match(r.out, new RegExp('usage: arcod ' + command + '\\b'), command + ' names itself');
  }
  const short = await run(['run', '-h']);
  assert.equal(short.code, 0);
  assert.match(short.out, /usage: arcod run/);
});

test('run --down stops the built project instead of rebuilding it', async () => {
  const dir = await tempDir('arcod-down-');
  const build = join(dir, '.arcod', 'build');
  await mkdir(build, { recursive: true });
  const composeFile = join(build, 'docker-compose.yml');
  const kept = 'name: arcod-down\nservices: {}\n';
  await writeFile(composeFile, kept);
  // An operation the emitters cannot template: a build here would fail, which
  // is exactly the case the stop button has to survive.
  await writeFile(join(dir, 'main.arc'), [
    'module down @0.1.0 {}',
    '',
    'type Note = { id: uuid, text: string }',
    '',
    'service Notes : http {',
    '  contract {',
    '    public op list() -> list<Note> { route: "GET /v1/notes" }',
    '  }',
    '}',
    '',
  ].join('\n'));

  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'docker.log');
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho "$@" >> ' + log + '\nexit 0\n', { mode: 0o755 });

  const before = process.env.PATH;
  process.env.PATH = bin + ':' + (before ?? '');
  try {
    const r = await run(['run', dir, '--down']);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out + r.err, /emitter v0|templates only/, 'no build was attempted');
  } finally {
    process.env.PATH = before;
  }

  assert.match(await readFile(log, 'utf8'), /compose -f .*docker-compose\.yml down --remove-orphans/);
  assert.equal(await readFile(composeFile, 'utf8'), kept, 'build artifacts are untouched');
  assert.deepEqual(await readdir(build), ['docker-compose.yml'], 'nothing was rebuilt');
});

test('run --down on a project that was never built is a quiet no-op', async () => {
  const dir = await tempDir('arcod-down-empty-');
  const r = await run(['run', dir, '--down']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to stop/);
});

test('run reports a missing docker instead of a stack trace', async () => {
  const dir = await tempDir('arcod-run-nodocker-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const empty = join(dir, 'empty-bin');
  await mkdir(empty);

  const before = process.env.PATH;
  process.env.PATH = empty;
  try {
    const r = await run(['run', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /docker is not running or unavailable/);
    assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  } finally {
    process.env.PATH = before;
  }
});

test('run --detach starts the project and prints how to stop it', async () => {
  const dir = await tempDir('arcod-run-detach-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'docker.log');
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho "$@" >> ' + log + '\nexit 0\n', { mode: 0o755 });

  const before = process.env.PATH;
  process.env.PATH = bin + ':' + (before ?? '');
  try {
    const r = await run(['run', dir, '--detach']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /url: +http:\/\/localhost:8080/);
    assert.match(r.out, /stop: arcod run/);
  } finally {
    process.env.PATH = before;
  }
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /compose -f .*docker-compose\.yml up --build -d/);
});

test('migrate on a spec without storage says so instead of inventing a kv table', async () => {
  const dir = await tempDir('arcod-migrate-plain-');
  await writeFile(join(dir, 'main.arc'), ['module plain @0.1.0 {}', '', 'service Plain : http {',
    '  contract {', '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}', ''].join('\n'));
  const r = await run(['migrate', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing to migrate/);
  assert.equal(await readdir(join(dir, '.arcod', 'build', 'migrations')).catch(() => null), null,
    'an empty plan writes no artifacts');
});

test('check accepts a pattern across projects', async () => {
  const root = await tempDir('arcod-glob-');
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'main.arc'), signup);
  }
  const ok = await run(['check', join(root, '*', 'main.arc')]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal((ok.out.match(/0 error\(s\)/g) ?? []).length, 2, 'both projects were checked');
  assert.match(ok.out, /2 file\(s\), 0 with errors/);

  const broken = ['module broken @0.1.0 {}', '', 'service Broken : http {', '  uses store: kv', '',
    '  contract {', '    public op read(id: uuid) -> string { route: "GET /v1/x" }', '  }', '}', ''].join('\n');
  await writeFile(join(root, 'beta', 'main.arc'), broken);
  const bad = await run(['check', join(root, '*', 'main.arc')]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /1 with errors/);

  const deep = await run(['check', join(root, '**', 'main.arc')]);
  assert.equal(deep.code, 1, '** finds the broken project too');

  const dirs = await run(['check', join(root, 'a*')]);
  assert.equal(dirs.code, 0, dirs.out);
  assert.match(dirs.out, /1 file\(s\), 0 with errors/, 'a matched directory resolves to its spec');

  const json = await run(['check', join(root, 'alpha', '*.arc'), '--json']);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.out);
  assert.equal(report.length, 1);
  assert.match(report[0].file, /alpha\/main\.arc$/);

  const none = await run(['check', join(root, 'nope', '*', 'main.arc')]);
  assert.equal(none.code, 2);
  assert.match(none.err, /no files match/);
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


test('check --env names the environments the module declares', async () => {
  const missing = await run(['check', signupUrl.pathname, '--env', 'staging']);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /unknown environment staging/);
  assert.match(missing.out, /declared: /);
  assert.doesNotMatch(missing.out, /is not bound/, 'the binding report is not the answer');

  const ok = await run(['check', signupUrl.pathname, '--env', 'dev']);
  assert.equal(ok.code, 0, ok.out);
});

test('check --strict asks for the budget the default check leaves alone', async () => {
  const dir = await tempDir('arcod-strict-');
  const file = join(dir, 'plain.arc');
  await writeFile(file, ['module plain @0.1.0 {}', '', 'service Plain : http {',
    '  contract {', '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}', ''].join('\n'));
  const loose = await run(['check', file]);
  assert.equal(loose.code, 0);
  assert.doesNotMatch(loose.out, /W013/);
  const strict = await run(['check', file, '--strict']);
  assert.match(strict.out, /W013/);
  assert.equal(strict.code, 0, 'a warning stays a warning, not an exit code');
});

test('check fails a broken spec with file:line:col and a parse hint', async () => {
  const dir = await tempDir();
  const file = join(dir, 'broken.arc');
  await writeFile(file, 'module broken @0.1.0 {\n  service {\n', 'utf8');
  const r = await run(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /broken\.arc:\d+:\d+ +error +parse/);
});

test('a lexer refusal is reported like a parse error, with a location', async () => {
  const dir = await tempDir();
  const file = join(dir, 'lex.arc');
  await writeFile(file, 'module demo @0.1.0 {\n  meta { owner: $ }\n}\n', 'utf8');
  const r = await run(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /lex\.arc:2:17\s+error\s+parse\s+unexpected character/);
  assert.match(r.err, /"\$"/, 'the offending character is quoted');
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

  // The dialect follows the bind, so an explicit postgres on a mysql-bound spec
  // is a usage error naming the bind; a postgres-bound copy is how you get
  // postgres DDL out of the same model.
  const conflict = await run(['migrate', spec, '--dialect', 'postgres']);
  assert.equal(conflict.code, 2, 'a dialect that disagrees with the bind is a usage error');
  assert.match(conflict.err, /bind store -> mysql/);

  const pgSpec = join(dir, 'main-postgres.arc');
  await writeFile(pgSpec, (await readFile(spec, 'utf8')).replaceAll('bind store -> mysql', 'bind store -> postgres'));
  const postgres = await run(['migrate', pgSpec]);
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

test('make prints a pipeline table and the same steps as JSON', async () => {
  const dir = await tempDir('arcod-cli-make-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');

  const human = await run(['make', spec, '--skip-impl', '--no-test']);
  assert.equal(human.code, 0, JSON.stringify(human.err));
  assert.match(human.out, /^arcod make: /m);
  assert.match(human.out, /check\s+ok/);
  assert.match(human.out, /impl\s+skip\s+skipped \(--skip-impl\)/);
  assert.match(human.out, /test\s+skip\s+skipped \(--no-test\)/);
  assert.match(human.out, /done in \d+ ms/);

  const json = await run(['make', spec, '--skip-impl', '--no-test', '--json']);
  assert.equal(json.code, 0, JSON.stringify(json.err));
  const result = JSON.parse(json.out);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step: { name: string }) => step.name), ['check', 'prompts', 'impl', 'build', 'test']);
});

test('make exits 1 and stops when check fails', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module bad @0.1.0 {\n  meta { owner: "@you" }\n}\n\nservice Bad : http {\n  contract {\n    public op go() -> string {\n      route: "GET /v1/go"\n      errors: Missing\n    }\n  }\n}\n', 'utf8');
  const r = await run(['make', file, '--skip-impl', '--no-test']);
  assert.equal(r.code, 1);
  assert.match(r.out, /stopped in/);
  assert.match(r.out, /check\s+fail/);
});


test('build refuses two impl bodies with one top-level name, exit 2', async () => {
  const dir = await tempDir('arcod-cli-dupname-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  for (const op of ['create', 'list']) {
    const file = join(dir, 'impl', op + '.mjs');
    await writeFile(file, (await readFile(file, 'utf8')) + '\nconst LINES = [];\n', 'utf8');
  }
  const r = await run(['build', join(dir, 'main.arc'), '--impl']);
  assert.equal(r.code, 2);
  assert.match(r.err, /duplicate top-level name "LINES"/);
  assert.match(r.err, /impl\/create\.mjs/);
  assert.match(r.err, /impl\/list\.mjs/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
});

test('prompts writes tasks and refuses a budget nothing fits', async () => {
  const dir = await tempDir('arcod-cli-prompts-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');

  const ok = await run(['prompts', spec]);
  assert.equal(ok.code, 0, JSON.stringify(ok.err));
  assert.match(ok.out, /prompts: \d+ \(model /);
  assert.match(ok.out, /written to .*prompts$/);
  const manifest = JSON.parse(await readFile(join(dir, '.arcod', 'build', 'prompts.json'), 'utf8'));
  assert.ok(manifest.tasks.length > 0);

  const cramped = await run(['prompts', spec, '--max-tokens', '1']);
  assert.equal(cramped.code, 1);
  assert.match(cramped.err, /over budget \(1\)/);
  assert.match(cramped.out, /over-budget/);
});

test('prompts --full explains the io surface instead of sketching it', async () => {
  const dir = await tempDir('arcod-cli-prompts-full-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');

  const compact = await run(['prompts', spec, '--json']);
  assert.equal(compact.code, 0, JSON.stringify(compact.err));
  const full = await run(['prompts', spec, '--full', '--json']);
  assert.equal(full.code, 0, JSON.stringify(full.err));

  const brief = JSON.parse(compact.out).tasks as Array<{ op: string; tokens: number; sha256: string }>;
  const detailed = JSON.parse(full.out).tasks as Array<{ op: string; tokens: number; sha256: string; file: string }>;
  assert.deepEqual(detailed.map((t) => t.op), brief.map((t) => t.op), 'the same operations are asked for');
  assert.notEqual(detailed[0].sha256, brief[0].sha256, 'the full prompt is a different document');
  assert.ok(detailed[0].tokens >= brief[0].tokens);

  const task = detailed[0];
  const prompt = await readFile(join(dir, '.arcod', 'build', 'prompts', task.op + '.md'), 'utf8');
  assert.match(prompt, /io\./, 'the full prompt names the io calls the body may use');
  assert.match(prompt, /export async function /);
});

test('upgrade reports the current version and refuses an unknown target', async () => {
  const already = await run(['upgrade', signupUrl.pathname]);
  assert.equal(already.code, 0);
  assert.match(already.out, /: already at 0\.1\.0$/);

  const refused = await run(['upgrade', signupUrl.pathname, '--to', '9.9.9']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /unknown target version 9\.9\.9/);
});

test('test runs the bodies in impl/ and reports every example', async () => {
  const dir = await tempDir('arcod-cli-test-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');

  const human = await run(['test', spec]);
  assert.equal(human.code, 0, human.out + human.err);
  assert.match(human.out, /^examples:/m);
  assert.match(human.out, /ok +create/);
  assert.match(human.out, /\d+ passed, 0 failed/);

  const json = await run(['test', spec, '--json']);
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out);
  assert.ok(report.examples.length > 0);
  assert.equal(report.examples.every((item: { ok: boolean }) => item.ok), true);
});

test('test --reference uses the demo handlers when impl/ exists', async () => {
  const dir = await tempDir('arcod-cli-ref-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const r = await run(['test', join(dir, 'main.arc'), '--reference']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\d+ passed, 0 failed/);
});

test('a body that lies about its contract turns the run red', async () => {
  const dir = await tempDir('arcod-cli-red-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  await writeFile(join(dir, 'impl', 'read.mjs'), 'export async function read(input, io) { return { error: "Gone" }; }\n', 'utf8');
  const r = await run(['test', join(dir, 'main.arc')]);
  assert.equal(r.code, 1, 'a failed example must not pass silently');
  assert.match(r.out, /fail/);
  assert.match(r.out, /, [1-9]\d* failed/);
});

test('test on a spec without examples says so and exits 0', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module demo @0.1.0 {\n  meta { owner: "@you" }\n}\n\nservice Ping : http {\n  contract {\n    public op ping() -> string {\n      route: "GET /v1/ping"\n    }\n  }\n}\n', 'utf8');
  const r = await run(['test', file]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /no examples or rules declared/);
});

test('test says bodies are missing instead of quoting the emitter', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module demo @0.1.0 {\n  meta { owner: "@you" }\n}\n\nservice Ping : http {\n  contract {\n    public op ping() -> string {\n      route: "GET /v1/ping"\n    }\n  }\n\n  examples {\n    example ping_ok {\n      when { let r = ping() }\n      then { r == "pong" }\n    }\n  }\n}\n', 'utf8');
  const r = await run(['test', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no operation bodies to test/);
  assert.match(r.err, /arcod impl/);
  assert.doesNotMatch(r.out + r.err, /templates only for/, 'the internal wording stays internal');
});

test('an emitter asked for a service that is not there names it', async () => {
  for (const command of ['openapi', 'graphql', 'grpc']) {
    const r = await run([command, signupUrl.pathname, '--service', 'Nope']);
    assert.equal(r.code, 1, command);
    assert.match(r.err, new RegExp('no service named Nope to emit'), command + ' names the request');
  }
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

test('deploy explains what it would write for each provider, and what is missing', async () => {
  const dir = await tempDir('arcod-cli-deploy-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');

  // dev binds docker: the text output points at the compose artifact.
  const compose = await run(['deploy', spec]);
  assert.equal(compose.code, 0, JSON.stringify(compose.err));
  assert.match(compose.out, /artifact: docker-compose\.yml — local build/);
  assert.match(compose.out, /run: arcod run /);

  // prod binds yandex: the manifest is the artifact, nothing is called.
  const managed = await run(['deploy', spec, '--env', 'prod']);
  assert.equal(managed.code, 0, JSON.stringify(managed.err));
  assert.match(managed.out, /artifact: deploy\.prod\.json — manifest, written by arcod build/);
  assert.match(managed.out, /no credentials, no API calls/);

  const missingEnv = await run(['deploy', spec, '--env', 'staging']);
  assert.equal(missingEnv.code, 1);
  assert.match(missingEnv.err, /no environment to deploy: staging/);

  // An environment without `deploy` gets the hint instead of an empty table.
  const original = await readFile(spec, 'utf8');
  await writeFile(spec, original.replace('  deploy docker\n', ''), 'utf8');
  const undeclared = await run(['deploy', spec]);
  assert.equal(undeclared.code, 0, JSON.stringify(undeclared.err));
  assert.match(undeclared.out, /dev: deploy is not declared \(docker is assumed by default\)/);
  assert.match(undeclared.out, /available providers: /);

  // A typo in the provider name is a one-line refusal, not a stack trace.
  await writeFile(spec, original.replace('  deploy docker\n', '  deploy nope\n'), 'utf8');
  const unknown = await run(['deploy', spec]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown deploy provider nope; available: /);
});

test('fmt --write keeps a comment written inside a ui block', async () => {
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  const src = [
    'module m @0.1.0 {}',
    'ui Board {',
    '  kind: spa',
    '  route: "/board"',
    '  // dark by default',
    '  theme: dark',
    '}',
    '',
  ].join('\n');
  await writeFile(file, src, 'utf8');
  const written = await run(['fmt', file, '--write']);
  assert.equal(written.code, 0, JSON.stringify(written.err));
  const out = await readFile(file, 'utf8');
  assert.match(out, /^  \/\/ dark by default\n  theme: dark$/m);
  const check = await run(['fmt', file, '--check']);
  assert.equal(check.code, 0, JSON.stringify(check.err));
});


test('a pattern names each file and keeps going after a parse error', async () => {
  const root = await tempDir('arcod-glob-broken-');
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'main.arc'), signup);
  }

  // Two projects, one spec name: a bare basename would print "main.arc" twice
  // and leave the reader guessing which project failed.
  const both = await run(['check', join(root, '*', 'main.arc')]);
  assert.equal(both.code, 0, both.out);
  for (const name of ['alpha', 'beta']) {
    assert.ok(both.out.includes(join(root, name, 'main.arc') + ':'), both.out);
  }

  // A declaration one brace too deep is a parse error now; the other project
  // must still be checked and the run must end with a summary, not a stack.
  await writeFile(join(root, 'beta', 'main.arc'),
    ['module beta @0.1.0 {', '  type T = { x: int }', '}'].join('\n'));
  const bad = await run(['check', join(root, '*', 'main.arc')]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /error {2}parse {2}unexpected token "type" in the module header/);
  assert.ok(bad.out.includes(join(root, 'beta', 'main.arc') + ':2:3'), bad.out);
  assert.ok(bad.out.includes(join(root, 'alpha', 'main.arc') + ':'), 'the healthy file is still checked');
  assert.match(bad.out, /2 file\(s\), 1 with errors/);
  assert.doesNotMatch(bad.out + bad.err, /\n\s+at /, 'no stack trace');

  const json = await run(['check', join(root, '*', 'main.arc'), '--json']);
  assert.equal(json.code, 1);
  const report = JSON.parse(json.out) as Array<{ file: string; error?: { message: string; line?: number } }>;
  assert.ok(report.length === 2, json.out);
  const broken = report.find((item) => item.error !== undefined)?.error;
  assert.ok(broken, json.out);
  assert.match(broken.message, /module header/);
  assert.equal(broken.line, 2);
});

test('fmt reads a pattern, --check gates it and --write repairs it', async () => {
  const root = await tempDir('arcod-fmt-glob-');
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'main.arc'),
      'module ' + name + ' @0.1.0 {\n meta { title: "' + name + '" }\n}\n');
  }

  const bare = await run(['fmt', join(root, '*', 'main.arc')]);
  assert.equal(bare.code, 2, 'printing several specs to one stdout is ambiguous');
  assert.match(bare.err, /needs --check or --write/);

  const check = await run(['fmt', join(root, '*', 'main.arc'), '--check']);
  assert.equal(check.code, 1, check.out);
  assert.ok(check.out.includes(join(root, 'alpha', 'main.arc') + ': not formatted'), check.out);
  assert.ok(check.out.includes(join(root, 'beta', 'main.arc') + ': not formatted'), check.out);
  assert.match(check.out, /2 file\(s\), 2 not formatted, 0 failed/);

  const write = await run(['fmt', join(root, '*', 'main.arc'), '--write']);
  assert.equal(write.code, 0, 'a successful write is not a failure: ' + write.out);
  const clean = await run(['fmt', join(root, '*', 'main.arc'), '--check']);
  assert.equal(clean.code, 0, clean.out);

  // A file that does not parse is reported with its location and left alone;
  // the other match is still checked.
  const brokenSource = ['module beta @0.1.0 {', '  type T = { x: int }', '}'].join('\n');
  await writeFile(join(root, 'beta', 'main.arc'), brokenSource);
  const broken = await run(['fmt', join(root, '*', 'main.arc'), '--check']);
  assert.equal(broken.code, 1);
  assert.ok(broken.out.includes(join(root, 'beta', 'main.arc') + ':2:3'), broken.out);
  assert.match(broken.out, /2 file\(s\), 0 not formatted, 1 failed/);
  assert.equal(await readFile(join(root, 'beta', 'main.arc'), 'utf8'), brokenSource,
    'a spec that does not parse is never rewritten');
});

test('every example is already in canonical form', async () => {
  // The formatting gate that CI cannot run yet (owner decision): the local
  // equivalent, so an example cannot drift from what fmt prints.
  const r = await run(['fmt', 'examples/*/main.arc', '--check']);
  assert.equal(r.code, 0, r.out);
  // Count the examples instead of hardcoding the number: a new example is a
  // promise to keep it formatted, not a reason to edit this test.
  const dirs = await readdir(new URL('../examples', import.meta.url), { withFileTypes: true });
  const specs = await Promise.all(dirs.filter((entry) => entry.isDirectory())
    .map((entry) => readFile(new URL('../examples/' + entry.name + '/main.arc', import.meta.url), 'utf8').catch(() => null)));
  const count = specs.filter((source) => source !== null).length;
  assert.ok(r.out.includes(count + ' file(s), 0 not formatted, 0 failed'), r.out);
});

test('a numeric flag is refused instead of publishing NaN', async () => {
  // --replicas abc used to reach the manifest as "replicas: NaN" with exit 0.
  const replicas = await run(['k8s', signupUrl.pathname, '--replicas', 'abc']);
  assert.equal(replicas.code, 2, replicas.out);
  assert.match(replicas.err, /invalid value for --replicas: "abc" \(expected an integer 1\.\.1000\)/);
  assert.match(replicas.err, /hint: arcod k8s --help/);

  const port = await run(['build', signupUrl.pathname, '--port', '70000']);
  assert.equal(port.code, 2);
  assert.match(port.err, /invalid value for --port/);

  const tokens = await run(['prompts', signupUrl.pathname, '--max-tokens', '0']);
  assert.equal(tokens.code, 2);
  assert.match(tokens.err, /invalid value for --max-tokens/);

  const ok = await run(['k8s', signupUrl.pathname, '--replicas', '3']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /replicas: 3/);
});

test('graphql/grpc --out create the directory they write into', async () => {
  const dir = await tempDir('arcod-out-');
  // A build script normally points --out at a directory that does not exist yet.
  const out = join(dir, 'build', 'schema.graphql');
  const sdl = await run(['graphql', signupUrl.pathname, '--out', out]);
  assert.equal(sdl.code, 0, sdl.err);
  assert.match(sdl.out, /wrote /);
  assert.match(await readFile(out, 'utf8'), /^type /m);

  const proto = join(dir, 'deep', 'api.proto');
  const grpc = await run(['grpc', signupUrl.pathname, '--out', proto]);
  assert.equal(grpc.code, 0, grpc.err);
  assert.match(await readFile(proto, 'utf8'), /^syntax = "proto3";/m);
});
