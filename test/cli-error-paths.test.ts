// Commands that emit infrastructure or DDL check the model first and refuse a
// broken spec with a diagnostic, not a stack trace. The upgrade path also has a
// no-op line for a spec already at the target version. None of the three was
// covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

interface Result {
  out: string;
  err: string;
  code: number;
}

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

const BROKEN = [
  'module m @0.1.0 {}',
  'service S : http {',
  '  roles: user',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/list"',
  '      roles: user',
  '    }',
  '  }',
  '}',
].join(String.fromCharCode(10));

async function project(spec: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-errors-'));
  await writeFile(join(dir, 'main.arc'), spec + String.fromCharCode(10), 'utf8');
  return dir;
}

test('terraform refuses a spec with an error and names it', async () => {
  const dir = await project(BROKEN);
  const result = await run(['terraform', join(dir, 'main.arc')]);
  assert.equal(result.code, 1, result.out);
  // Diagnostics go to stdout — the same stream a clean run reports on.
  assert.match(result.out, /A048/);
  assert.equal(result.out.includes('resource '), false, 'no plan is printed for a broken spec');
});

test('migrate refuses a spec with an error and names it', async () => {
  const dir = await project(BROKEN);
  const result = await run(['migrate', join(dir, 'main.arc')]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /A048/);
  assert.equal(result.out.includes('CREATE TABLE'), false, 'no DDL is printed for a broken spec');
});

test('upgrade says a spec is already at the target version', async () => {
  const dir = await project('module m @0.1.0 {}');
  const result = await run(['upgrade', join(dir, 'main.arc'), '--to', '0.1.0']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /: already at 0\.1\.0$/m);
});

// The same refusal belongs to every artifact command: openapi, graphql, grpc,
// k8s and prompts each check the model first. A `--out` that writes a file for
// a broken spec is worse than a diagnostic: the artifact looks built.
const ARTIFACTS: Array<{ command: string; args: string[]; out: string }> = [
  { command: 'openapi', args: ['--out', 'api/openapi.json'], out: 'api/openapi.json' },
  { command: 'graphql', args: ['--out', 'api/schema.graphql'], out: 'api/schema.graphql' },
  { command: 'grpc', args: ['--out', 'api/service.proto'], out: 'api/service.proto' },
  { command: 'k8s', args: ['--out', 'deploy/k8s'], out: 'deploy/k8s' },
];

test('prompts refuses a broken spec and writes no prompt set', async () => {
  const dir = await project(BROKEN);
  const result = await run(['prompts', join(dir, 'main.arc')]);
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /A048/);
  assert.equal(existsSync(join(dir, '.arcod', 'build', 'prompts')), false, 'no prompt set for a broken spec');
});

for (const artifact of ARTIFACTS) {
  test(artifact.command + ' refuses a broken spec and writes no artifact', async () => {
    const dir = await project(BROKEN);
    const target = join(dir, artifact.out);
    const result = await run([artifact.command, join(dir, 'main.arc'), ...artifact.args]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.out, /A048/);
    assert.equal(existsSync(target), false, artifact.command + ' wrote ' + artifact.out + ' for a broken spec');
  });
}

// `arcod run` shells out to docker. When the binary is there for the health
// probe but gone for compose (a stopped daemon, a PATH that changed under the
// process), spawnSync reports ENOENT in child.error and the command must say so
// and exit 1 — the branch printed nothing at all until now.
const RUNSPEC = [
  'module runme @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.ids @1',
  '',
  'type Id = uuid',
  '',
  'service Ping : http {',
  '  uses store: kv(ttl: 60s)',
  '  uses uuid: ids',
  '',
  '  contract {',
  '    public op create() -> Id {',
  '      route: "POST /v1/ping"',
  '      effects: store.set, uuid.new',
  '      post: result != null',
  '    }',
  '',
  '    public op read(id: Id) -> bool {',
  '      route: "GET /v1/ping/:id"',
  '      effects: store.get',
  '    }',
  '  }',
  '',
  '  effects {',
  '    allow store.get, store.set, uuid.new',
  '    deny net, fs, exec',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind uuid -> local',
  '  deploy docker',
  '}',
  '',
].join('\n');

test('run reports a docker binary that disappears before compose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-run-'));
  await writeFile(join(dir, 'main.arc'), RUNSPEC, 'utf8');

  const bin = join(dir, 'bin');
  await mkdir(bin);
  // Answers `docker info` (the probe) and removes itself, so the compose call
  // that follows cannot resolve the binary. /bin/rm is spelled out because with
  // only the shim dir on PATH there is no `rm` to find, and a plain `rm` left
  // the shim in place — the compose call then exited 1 with no message at all.
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = info ]; then /bin/rm -f "$0"; exit 0; fi\nexit 1\n', { mode: 0o755 });

  const before = process.env.PATH;
  // The shim dir only. With the host PATH behind it, a runner that does have
  // docker found the real binary once the shim had deleted itself and ran
  // `compose up --build` for real: the foreground compose never returned and
  // CI killed the job at its 20-minute limit (run 45063415633). This test is
  // about having no docker binary left, so nothing behind the shim may exist.
  process.env.PATH = bin;
  let result: Result;
  try {
    result = await run(['run', dir]);
  } finally {
    process.env.PATH = before;
  }

  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.err, /docker/, 'the message names docker, not a bare stack');
  assert.match(result.err, /ENOENT|not found/, 'and says the binary was not found');
});

test('run --down on a project that was never built is a no-op, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-run-'));
  await writeFile(join(dir, 'main.arc'), RUNSPEC, 'utf8');
  const result = await run(['run', dir, '--down']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /nothing to stop/);
});

// The reference handlers need create and read together; a service that has only
// create never builds. `arcod run` used to surface the emitter's internal
// sentence ("templates only for create, read; got: create"), which names no
// missing body and no flag that would start anyway.
test('run explains the missing demo body and offers the scaffold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-run-'));
  const createOnly = RUNSPEC.replace(/    public op read[\s\S]*?\n    \}\n/, '');
  assert.equal(createOnly.includes('op read'), false, 'the fixture has one operation');
  await writeFile(join(dir, 'main.arc'), createOnly, 'utf8');
  const result = await run(['run', dir]);
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.err, /demo handlers cover create and read only/);
  assert.match(result.err, /--scaffold/, 'the flag that would start is named');
  assert.equal(/templates only for/.test(result.err), false, 'the emitter wording stays out: ' + result.err);
});

// A spec that does not check must not reach docker: 'arcod run' probed the
// daemon and called compose even when the diagnostics already said the spec
// was broken.
test('run refuses a broken spec before it asks docker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-run-'));
  await writeFile(join(dir, 'main.arc'), BROKEN, 'utf8');
  const bin = join(dir, 'bin');
  const log = join(dir, 'docker.log');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho "$@" >> ' + log + '\nexit 0\n', { mode: 0o755 });

  const before = process.env.PATH;
  process.env.PATH = bin;
  let result: Result;
  try {
    result = await run(['run', dir]);
  } finally {
    process.env.PATH = before;
  }

  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /A048/, 'the diagnostic code is printed');
  assert.equal(existsSync(log), false, 'docker is never asked about a spec that does not build');
});

// --scaffold is the third head of 'arcod run': bodies are stubs, the service
// still starts, and the compose call stays in the foreground.
test('run --scaffold names the stubs and keeps the foreground compose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-run-'));
  await writeFile(join(dir, 'main.arc'), RUNSPEC, 'utf8');
  const bin = join(dir, 'bin');
  const log = join(dir, 'docker.log');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'),
    '#!/bin/sh\nif [ "$1" = info ]; then exit 0; fi\necho "$@" >> ' + log + '\nexit 3\n',
    { mode: 0o755 });

  const before = process.env.PATH;
  process.env.PATH = bin;
  let result: Result;
  try {
    result = await run(['run', dir, '--scaffold']);
  } finally {
    process.env.PATH = before;
  }

  assert.equal(result.code, 3, 'the compose status is the exit status: ' + result.out + result.err);
  assert.match(result.out, /arcod run: scaffold/);
  assert.doesNotMatch(result.out, /stop: arcod run/, 'a foreground run prints no stop hint');
  assert.match(await readFile(log, 'utf8'), /compose -f .*docker-compose\.yml up --build$/m);
});

// --dialect is checked once, in one place, and the mistake is the user's: a
// typo has to read as a usage error with the accepted values, not as a build
// that half-ran.
test('an unknown --dialect is a usage error and builds nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-dialect-'));
  await writeFile(join(dir, 'main.arc'), RUNSPEC, 'utf8');

  const result = await run(['build', dir, '--dialect', 'sqlite']);

  assert.equal(result.code, 2, 'usage errors exit 2: ' + result.out + result.err);
  assert.match(result.err, /unknown dialect sqlite \(mysql, postgres\)/);
  assert.match(result.err, /hint: arcod build --help/);
  assert.equal(existsSync(join(dir, '.arcod', 'build')), false, 'nothing was built');
});
