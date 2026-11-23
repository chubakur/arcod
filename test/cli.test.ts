import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

// 'atomic read { get; del }' needs an error for an already-consumed key.
// Dropping Gone from the one-time-message demo leaves its plan underivable
// while the spec itself still checks clean (one warning, no model needed).
async function underivableProject(): Promise<{ dir: string; spec: string }> {
  const dir = await tempDir('arcod-cli-unresolved-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');
  let text = await readFile(spec, 'utf8');
  text = text
    .replace('error Gone\n', '')
    .replace('    invariant read.at_most_once: once(read, by: id, else: Gone)\n', '')
    .replace('      errors: NotFound, Gone', '      errors: NotFound')
    .replace('        read(id) is Gone\n', '');
  await writeFile(spec, text);
  // No impl/ bodies: the run has to derive the plan, not skip the prompts.
  await rm(join(dir, 'impl'), { recursive: true, force: true });
  return { dir, spec };
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

// The summary page once said "fmt/upgrade share --check and --write", and the
// README repeated it. upgrade never had --check: a CI gate written from that
// sentence would have failed on a usage error instead of on version drift.
test('upgrade has no --check: the promised gate is a usage error', async () => {
  const r = await run(['upgrade', 'examples/chat', '--check']);
  assert.equal(r.code, 2);
  assert.match(r.err, /arcod: unknown flag: --check/);
  assert.match(r.err, /hint: arcod upgrade --help/);
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

test('run --down on a built project without docker does not pretend it stopped', async () => {
  const dir = await tempDir('arcod-down-nodocker-');
  const build = join(dir, '.arcod', 'build');
  await mkdir(build, { recursive: true });
  const composeFile = join(build, 'docker-compose.yml');
  const kept = 'name: arcod-down\nservices: {}\n';
  await writeFile(composeFile, kept);
  const empty = join(dir, 'empty-bin');
  await mkdir(empty);

  const before = process.env.PATH;
  process.env.PATH = empty;
  try {
    const r = await run(['run', dir, '--down']);
    assert.equal(r.code, 1);
    assert.match(r.err, /docker is not running or unavailable/);
    assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  } finally {
    process.env.PATH = before;
  }
  assert.equal(await readFile(composeFile, 'utf8'), kept, 'a failed stop leaves the artifacts alone');
});

test('run without --detach builds in the foreground and keeps the compose status', async () => {
  const dir = await tempDir('arcod-run-fg-');
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'docker.log');
  // docker answers info, compose fails: the point is the exit status a user
  // scripts against, and that no detach flag sneaks in.
  await writeFile(join(bin, 'docker'),
    '#!/bin/sh\nif [ "$1" = "info" ]; then exit 0; fi\necho "$@" >> ' + log + '\nexit 3\n',
    { mode: 0o755 });

  const before = process.env.PATH;
  process.env.PATH = bin + ':' + (before ?? '');
  try {
    const r = await run(['run', dir]);
    assert.equal(r.code, 3, 'a failed compose up becomes the CLI exit status');
    assert.doesNotMatch(r.out, /stop: arcod run/, 'a foreground run prints no stop hint');
  } finally {
    process.env.PATH = before;
  }
  const calls = (await readFile(log, 'utf8')).trimEnd();
  assert.match(calls, /compose -f .*docker-compose\.yml up --build$/m, 'foreground up, no -d');
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

test('diff accepts a directory and names a directory without a spec', async () => {
  const signupDir = new URL('../examples/signup', import.meta.url).pathname;
  const same = runChild(['diff', signupDir, signupDir]);
  assert.equal(same.code, 0, same.err);
  assert.match(same.out, /^--- .*main\.arc\n\+\+\+ .*main\.arc\n$/);
  assert.equal(same.out.includes('@@'), false, 'an identical pair has no hunks');

  const empty = await mkdtemp(join(tmpdir(), 'arcod-diff-empty-'));
  const none = runChild(['diff', empty, signupDir]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no \.arc file found in /);
  assert.equal(none.out, '');
});

test('adopt rejects YAML with a pointer to JSON', async () => {
  const dir = await tempDir();
  const file = join(dir, 'openapi.yaml');
  await writeFile(file, 'openapi: 3.0.0\n', 'utf8');
  const r = await run(['adopt', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /only JSON OpenAPI documents/);
});

test('adopt refuses a Swagger 2.0 document in one line, not a stack trace', async () => {
  const dir = await tempDir();
  const file = join(dir, 'swagger.json');
  await writeFile(file, JSON.stringify({ swagger: '2.0', info: { title: 'Pet' }, paths: {} }), 'utf8');
  const r = await run(['adopt', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Swagger 2\.0/);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
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
    // The project the caller named relatively is reported relatively, not as
    // the absolute path scaffold happened to resolve.
    assert.match(ok.out, /^created demo-app$/m);
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

  // --out is the file counterpart of the stdout document, and it creates the
  // directory the same way graphql/grpc do.
  const openapiFile = await run(['openapi', spec, '--out', 'api/openapi.json']);
  assert.equal(openapiFile.code, 0, JSON.stringify(openapiFile.err));
  assert.match(openapiFile.out, /wrote .*api\/openapi\.json/);
  assert.match(JSON.parse(await readFile(join(dir, 'api', 'openapi.json'), 'utf8')).openapi, /^3\./);

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


test('make stops at cannot-derive and keeps that step in --json', async () => {
  const { spec } = await underivableProject();
  const json = await run(['make', spec, '--json']);
  assert.equal(json.code, 1);
  const result = JSON.parse(json.out) as { ok: boolean; steps: Array<{ name: string; ok: boolean; error?: string }> };
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((step) => step.name), ['check', 'prompts']);
  const prompts = result.steps[1];
  assert.equal(prompts.ok, false);
  assert.match(prompts.error ?? '', /cannot derive a procedure for: T-\d+: consume is required/);

  const human = await run(['make', spec]);
  assert.equal(human.code, 1);
  assert.match(human.out, /prompts\s+fail/);
  assert.match(human.out, /stopped in/);
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

test('prompts names an underivable plan and exits 1, JSON included', async () => {
  // The prompts it can write are still worth writing, so the command does not
  // throw the folder away: it says which operation has no procedure and sets
  // exit 1. The JSON manifest carries the same reason for a caller.
  const { dir, spec } = await underivableProject();

  const human = await run(['prompts', spec]);
  assert.equal(human.code, 1);
  assert.match(human.err, /cannot derive a procedure from the model:/);
  assert.match(human.err, /consume is required but the operation declares no error/);
  assert.match(human.out, /written to .*prompts$/);
  const files = await readdir(join(dir, '.arcod', 'build', 'prompts'));
  assert.ok(files.includes('read.md'), 'the prompt that could be built is still written');
  assert.ok(files.includes('manifest.json'));

  const json = await run(['prompts', spec, '--json']);
  assert.equal(json.code, 1);
  const manifest = JSON.parse(json.out) as { tasks: Array<{ op: string; unresolved: string[] }> };
  const read = manifest.tasks.find((task) => task.op === 'read')!;
  assert.equal(read.unresolved.length, 1);
  assert.match(read.unresolved[0], /consume is required/);
});
test('upgrade reports the current version and refuses an unknown target', async () => {
  const already = await run(['upgrade', signupUrl.pathname]);
  assert.equal(already.code, 0);
  assert.match(already.out, /: already at 0\.1\.0$/);

  const refused = await run(['upgrade', signupUrl.pathname, '--to', '9.9.9']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /unknown target version 9\.9\.9/);
});

// `arcod impl --json` is the machine-readable face of the model loop: one
// object per operation with ok/provenance, and a non-zero exit when any body
// was refused. The model is a local mock, so the test needs no Ollama.
test('impl --json reports every generated body and its provenance', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'export async function ping() {\n  return "pong";\n}' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    const dir = await tempDir();
    const spec = join(dir, 'main.arc');
    await writeFile(spec, [
      'module demo @0.1.0 {}',
      'service Ping : http {',
      '  contract {',
      '    public op ping() -> string {',
      '      route: "GET /v1/ping"',
      '    }',
      '  }',
      '}',
    ].join('\n'), 'utf8');
    const r = await run(['impl', spec, '--endpoint', endpoint, '--json', '--no-cache']);
    assert.equal(r.code, 0, r.err);
    const results = JSON.parse(r.out) as Array<{ id: string; ok: boolean; model?: string }>;
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.match(await readFile(join(dir, 'impl', 'ping.mjs'), 'utf8'), /export async function ping/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

  // A cluster target names the artifact directory and the preview command that
  // writes it: the same objects, with --helm for a chart.
  await writeFile(spec, original.replace('  deploy docker\n', '  deploy kubernetes\n'), 'utf8');
  const k8s = await run(['deploy', spec]);
  assert.equal(k8s.code, 0, JSON.stringify(k8s.err));
  assert.match(k8s.out, /artifact: k8s\/ — manifests written by arcod build/);
  assert.match(k8s.out, /preview: arcod k8s /);
  assert.equal(k8s.out.includes('--helm'), false);

  await writeFile(spec, original.replace('  deploy docker\n', '  deploy helm\n'), 'utf8');
  const helm = await run(['deploy', spec]);
  assert.equal(helm.code, 0, JSON.stringify(helm.err));
  assert.match(helm.out, /artifact: helm\/ — manifests written by arcod build/);
  assert.match(helm.out, /preview: arcod k8s .* --helm/);
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

  // A --to migration failure is one failed file, not a crash: the loop keeps
  // going and the summary/exit code record it.
  const migrate = await run(['fmt', join(root, '*', 'main.arc'), '--check', '--to', '0.0.1']);
  assert.equal(migrate.code, 1, migrate.out);
  assert.ok(migrate.out.includes(join(root, 'alpha', 'main.arc') + ': unknown target version 0.0.1'), migrate.out);
  assert.match(migrate.out, /2 file\(s\), 0 not formatted, 2 failed/);

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

test('deploy names the environments that exist when the one asked for does not', async () => {
  const dir = await tempDir('arcod-cli-deploy-env-');
  const spec = join(dir, 'main.arc');

  // No environment at all: the mention of none is the fix (add one), not a typo.
  await writeFile(spec, [
    'module envless @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  const none = await run(['deploy', spec]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no environment to deploy — module envless declares none; add `environment staging \{ deploy docker \}`/);

  // A --env typo shows what could have been meant instead of a bare refusal.
  await writeFile(spec, [
    'module twos @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'environment dev {',
    '}',
    'environment prod {',
    '}',
    '',
  ].join('\n'), 'utf8');
  const typo = await run(['deploy', spec, '--env', 'staging']);
  assert.equal(typo.code, 1);
  assert.match(typo.err, /no environment to deploy: staging — declared: dev, prod/);
});

test('a path that does not exist is missing, not a directory without a spec', async () => {
  const dir = await tempDir('arcod-cli-missing-');
  const missing = await run(['check', join(dir, 'nope.arc')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read .*nope\.arc: no such file or directory/);
  assert.doesNotMatch(missing.err, /no \.arc file found/);

  // A directory that does exist but holds no spec keeps the directory wording,
  // because there the missing thing really is the spec file.
  const empty = await run(['check', dir]);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /no \.arc file found in /);
});

test('a flag another command owns is a usage error here, not a silent no-op', async () => {
  const dir = await tempDir('arcod-cli-flags-');
  const spec = join(dir, 'main.arc');
  await writeFile(spec, [
    'module flags @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'service Ping : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /ping"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');

  // build writes .arcod/build and has no --out: accepting it was a no-op that
  // looked like success.
  const out = await run(['build', spec, '--out', join(dir, 'build')]);
  assert.equal(out.code, 2);
  assert.match(out.err, /unknown flag: --out/);
  assert.match(out.err, /hint: arcod build --help/);
  assert.equal((await readdir(dir)).includes('build'), false, 'nothing is written');

  const port = await run(['check', spec, '--port', '1']);
  assert.equal(port.code, 2);
  assert.match(port.err, /unknown flag: --port/);

  // A flag the command does read still passes: graphql owns --out.
  await mkdir(join(dir, 'out'), { recursive: true });
  const gql = await run(['graphql', spec, '--out', join(dir, 'out', 'schema.graphql')]);
  assert.equal(gql.code, 0, JSON.stringify(gql.err));
});

test('adopt on a path that does not exist names the path, not ENOENT', async () => {
  const dir = await tempDir('arcod-cli-adopt-missing-');
  const missing = await run(['adopt', join(dir, 'nope.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^cannot read .*nope\.json: no such file or directory$/m);
  assert.doesNotMatch(missing.err, /ENOENT/);

  // A file that exists but is not JSON keeps its own, different message.
  await writeFile(join(dir, 'spec.yaml'), 'openapi: 3.1.0\n', 'utf8');
  const yaml = await run(['adopt', join(dir, 'spec.yaml')]);
  assert.equal(yaml.code, 1);
  assert.match(yaml.err, /only JSON OpenAPI documents are supported/);
});

test('--reference with --impl is a usage error, not a silent preference', async () => {
  const dir = await tempDir('arcod-cli-modes-');
  const spec = join(dir, 'main.arc');
  await writeFile(spec, [
    'module modes @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');

  const both = await run(['build', spec, '--reference', '--impl']);
  assert.equal(both.code, 2);
  assert.match(both.err, /--reference and --impl are alternatives; pass one/);
  assert.equal(await readdir(dir).then((names) => names.some((n) => n.startsWith('.arcod'))), false);
});

test('build --reference explains the demo gap instead of quoting the emitter', async () => {
  const dir = await tempDir('arcod-cli-reference-');
  const spec = join(dir, 'main.arc');
  await writeFile(spec, [
    'module refgap @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'service Ping : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /ping"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');

  const r = await run(['build', spec, '--reference']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no operation bodies to build: --reference covers only create and read/);
  assert.match(r.err, /arcod impl/);
  assert.doesNotMatch(r.out + r.err, /templates only for/, 'the internal wording stays internal');
  // The emitter throws before it writes: an empty .arcod skeleton may exist,
  // but no bundle that `run` could pick up.
  const bundle = await readdir(join(dir, '.arcod', 'build')).catch(() => [] as string[]);
  assert.equal(bundle.includes('docker-compose.yml'), false, 'a failed build leaves no bundle');
});

test('build and migrate write the same migrations, byte for byte', async () => {
  const dir = await tempDir('arcod-cli-migrate-same-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const built = await run(['build', dir, '--impl', '--json']);
  assert.equal(built.code, 0, built.err);
  const migrations = join(dir, '.arcod', 'build', 'migrations');
  const before = new Map<string, string>();
  for (const name of await readdir(migrations)) before.set(name, await readFile(join(migrations, name), 'utf8'));
  assert.ok(before.size > 1, 'the build wrote migrations');
  const migrated = await run(['migrate', dir]);
  assert.equal(migrated.code, 0, migrated.err);
  const after = new Map<string, string>();
  for (const name of await readdir(migrations)) after.set(name, await readFile(join(migrations, name), 'utf8'));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file appears or disappears');
  for (const [name, text] of before) assert.equal(after.get(name), text, name + ' is unchanged by migrate');
});

test('build --json reports the build as one object, the human lines suppressed', async () => {
  const dir = await tempDir('arcod-cli-build-json-');
  await cp(new URL('../examples/tasks-sql', import.meta.url), dir, { recursive: true });
  const r = await run(['build', dir, '--impl', '--json']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out) as {
    mode: string; dir: string; dialect: string; port: number; reference: boolean;
    files: string[]; images: string[]; bodies: string[];
  };
  assert.equal(report.mode, 'impl');
  assert.equal(report.dialect, 'mysql');
  assert.equal(report.reference, false);
  assert.equal(report.port, 8080);
  assert.equal(report.dir, join(dir, '.arcod', 'build'));
  assert.ok(report.files.some((file) => file.endsWith('service/index.mjs')), 'the service is listed');
  assert.ok(report.files.some((file) => file.endsWith('migrations/changelog.json')), 'migrations are part of the report');
  assert.ok(report.images.length > 0, 'the content-addressed tags are reported');
  assert.ok(report.bodies.length > 0 && report.bodies.every((op) => typeof op === 'string'));
  assert.doesNotMatch(r.out, /arcod build \(/, 'one object, no human preamble');
});

test('migrate removes SQL files the new plan no longer owns', async () => {
  const dir = await tempDir('arcod-cli-prune-');
  const file = join(dir, 'main.arc');
  await writeFile(file, "module prune @0.1.0 {\n  meta {\n    owner: \"@me\"\n  }\n}\nuse capability arcod.std.sql @1\n\ntype A = { id: uuid, x: int }\ntype B = { id: uuid, y: int }\n\nservice S : http {\n  uses store: sql\n\n  effects {\n    allow store.insert, store.find\n  }\n\n  contract {\n    public op put(x: int) -> A {\n      route: \"POST /v1/a\"\n      effects: store.insert\n    }\n  }\n}\n\nenvironment dev {\n  bind store -> mysql\n  deploy docker\n}\n", 'utf8');
  const first = await run(['migrate', dir]);
  assert.equal(first.code, 0, first.err);
  const migrations = join(dir, '.arcod', 'build', 'migrations');
  const before = (await readdir(migrations)).filter((name) => name.endsWith('.sql'));
  assert.ok(before.some((name) => name.endsWith('_b.up.sql')), before.join(', '));
  // The second version drops B: its files must not survive as orphans beside
  // the new changelog, or a runner globbing *.up.sql would apply dead SQL.
  await writeFile(file, "module prune @0.1.0 {\n  meta {\n    owner: \"@me\"\n  }\n}\nuse capability arcod.std.sql @1\n\ntype A = { id: uuid, x: int }\n\nservice S : http {\n  uses store: sql\n\n  effects {\n    allow store.insert, store.find\n  }\n\n  contract {\n    public op put(x: int) -> A {\n      route: \"POST /v1/a\"\n      effects: store.insert\n    }\n  }\n}\n\nenvironment dev {\n  bind store -> mysql\n  deploy docker\n}\n", 'utf8');
  const second = await run(['migrate', dir]);
  assert.equal(second.code, 0, second.err);
  const after = (await readdir(migrations)).filter((name) => name.endsWith('.sql'));
  assert.equal(after.some((name) => name.endsWith('_b.up.sql')), false, after.join(', '));
  assert.equal(after.some((name) => name.endsWith('_b.down.sql')), false, after.join(', '));
  const changelog = JSON.parse(await readFile(join(migrations, 'changelog.json'), 'utf8')) as Array<{ name: string }>;
  assert.equal(changelog.some((migration) => migration.name === 'b'), false);

  // Losing the last table clears the artifact as well: nothing else would ever
  // rewrite those files, and "nothing to migrate" must not leave SQL behind.
  await writeFile(file, "module plain @0.1.0 {\n  meta {\n    owner: \"@me\"\n  }\n}\n\nservice Plain : http {\n  contract {\n    public op ping() -> string {\n      route: \"GET /v1/ping\"\n    }\n  }\n}\n", 'utf8');
  const third = await run(['migrate', dir]);
  assert.equal(third.code, 0, third.err);
  assert.match(third.out, /nothing to migrate/);
  const left = (await readdir(migrations)).filter((name) => name.endsWith('.sql') || name === 'changelog.json');
  assert.deepEqual(left, [], left.join(', '));
});

test('test --json prints an empty report as JSON, not a sentence', async () => {
  const dir = await tempDir('arcod-cli-json-empty-');
  const spec = join(dir, 'main.arc');
  await writeFile(spec, [
    'module noex @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    'service Ping : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /ping"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');

  const r = await run(['test', spec, '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { examples: [], rules: [] });

  // The human path keeps its sentence.
  const text = await run(['test', spec]);
  assert.equal(text.code, 0);
  assert.match(text.out, /no examples or rules declared/);
});

test('a directory with several specs says which one it read', async () => {
  const dir = await tempDir('arcod-cli-multi-');
  const body = (name: string) => [
    'module ' + name + ' @0.1.0 {',
    '  meta {',
    '    owner: "@me"',
    '  }',
    '}',
    '',
  ].join('\n');
  await writeFile(join(dir, 'b.arc'), body('b'), 'utf8');
  await writeFile(join(dir, 'a.arc'), body('a'), 'utf8');

  const r = await run(['check', dir]);
  assert.equal(r.code, 0, JSON.stringify(r.err));
  assert.match(r.err, /holds 2 specs; reading a\.arc \(also: b\.arc\)/);
  assert.match(r.out, /a\.arc is clean/);

  // A preferred name ends the ambiguity: main.arc is read and nothing is said.
  await writeFile(join(dir, 'main.arc'), body('m'), 'utf8');
  const preferred = await run(['check', dir]);
  assert.equal(preferred.code, 0, JSON.stringify(preferred.err));
  assert.doesNotMatch(preferred.err, /holds \d+ specs/);
});

test('--reference names the operations it has no demo body for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-gap-'));
  const spec = [
    'module gap @0.1.0 {',
    '}',
    '',
    'service Gap : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /v1/ping"',
    '    }',
    '',
    '    public op echo(text: string) -> string {',
    '      route: "POST /v1/echo"',
    '    }',
    '  }',
    '',
    '  examples {',
    '    example ping_ok {',
    '      when { let r = ping() }',
    '      then { r == "pong" }',
    '    }',
    '  }',
    '}',
    '',
    'environment dev {',
    '  deploy docker',
    '}',
    '',
  ].join('\n');
  await writeFile(join(dir, 'main.arc'), spec, 'utf8');
  await mkdir(join(dir, 'impl'), { recursive: true });

  const build = await run(['build', '--reference', dir]);
  assert.equal(build.code, 1);
  assert.match(build.err, /no demo body for ping, echo/);
  assert.match(build.err, /impl\/ping\.mjs, impl\/echo\.mjs/);

  const test = await run(['test', '--reference', dir]);
  assert.equal(test.code, 1);
  assert.match(test.err, /no demo body for ping, echo/);
});

test('ast --check gates on semantic errors and --json bypasses the gate', async () => {
  // A spec can parse and still fail check: a public op without a route is
  // A050. `ast --check` is the CI-facing gate, so it has to report the
  // diagnostic and exit 1 instead of printing an AST nobody should trust.
  const dir = await tempDir();
  const file = join(dir, 'main.arc');
  await writeFile(file, [
    'module m @0.1.0 {}',
    'service Ping : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      post: result == "pong"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  const gated = await run(['ast', file, '--check']);
  assert.equal(gated.code, 1);
  assert.match(gated.out, /A050/);
  assert.ok(!gated.out.trimStart().startsWith('{'), 'no AST is printed when the gate trips');
  const json = await run(['ast', file, '--check', '--json']);
  assert.equal(json.code, 0, '--json is a machine surface and skips the human gate');
  assert.equal(JSON.parse(json.out).name, 'm');
});

test('prompts on a contract with no operations says so and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-noops-'));
  const oneOp = [
    'module shrink @0.1.0 {}',
    'service S : http {',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /v1/ping"',
    '    }',
    '  }',
    '}',
    '',
  ].join(String.fromCharCode(10));
  const noOps = ['module shrink @0.1.0 {}', 'service S : http {', '}', ''].join(String.fromCharCode(10));
  try {
    await writeFile(join(dir, 'main.arc'), oneOp, 'utf8');
    const first = await run(['prompts', dir]);
    assert.equal(first.code, 0);
    const files = await readdir(join(dir, '.arcod', 'build', 'prompts'));
    assert.ok(files.includes('ping.md'));
    assert.ok(files.includes('manifest.json'));

    // The contract shrank: the prompt of a removed operation must not survive,
    // and a contract with no operations leaves no prompts.json at all.
    await writeFile(join(dir, 'main.arc'), noOps, 'utf8');
    const second = await run(['prompts', dir]);
    assert.equal(second.code, 0);
    assert.match(second.out, /no operations in shrink — no prompts to build/);
    const after = await readdir(join(dir, '.arcod', 'build', 'prompts')).catch(() => [] as string[]);
    assert.ok(!after.includes('ping.md'));
    const manifest = await readFile(join(dir, '.arcod', 'build', 'prompts.json'), 'utf8').catch(() => null);
    assert.equal(manifest, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build says which bodies it used and when impl/ is empty', async () => {
  const withBodies = await tempDir('arcod-cli-build-impl-');
  await cp(new URL('../examples/notes-ssr', import.meta.url), withBodies, { recursive: true });
  const ok = await run(['build', join(withBodies, 'main.arc'), '--impl']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /arcod build \(impl\): \d+ files in /);
  assert.match(ok.out, / {2}bodies: .*create/);
  assert.match(ok.out, / {2}images: /);

  // --impl with nothing in impl/ is not an error: the service still builds, and
  // the line tells the user the one command that would fill it in.
  const noBodies = await tempDir('arcod-cli-build-empty-');
  await cp(new URL('../examples/notes-ssr', import.meta.url), noBodies, { recursive: true });
  await rm(join(noBodies, 'impl'), { recursive: true, force: true });
  const bare = await run(['build', join(noBodies, 'main.arc'), '--impl']);
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /no bodies in impl\/; run arcod impl first/);
});
