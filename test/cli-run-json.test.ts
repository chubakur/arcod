import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

// 'arcod run --json' is the script-facing head of run: start the project in the
// background and answer one object. These tests pin the contract — one JSON
// payload and nothing else on stdout — and the three refusals that used to be
// either prose or a silently ignored flag.

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

// A service with one operation the reference handlers do not cover: it parses
// and checks clean, so the run reaches the emitter and gets its refusal.
const ONE_OP = ['module gap @0.1.0 {}', '', 'service S : http {', '  contract {',
  '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}'].join('\n');

// A spec that parses but does not check: 'user' is not a declared role.
const BROKEN = ['module m @0.1.0 {}', 'service S : http {', '  roles: user', '  contract {',
  '    public op list() -> bool {', '      route: "GET /v1/list"', '      roles: user', '    }',
  '  }', '}'].join('\n');

async function project(spec: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-runjson-'));
  await writeFile(join(dir, 'main.arc'), spec, 'utf8');
  return dir;
}

async function fakeDocker(dir: string, script: string): Promise<{ path: string; log: string }> {
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'docker.log');
  await writeFile(join(bin, 'docker'), script.replace(/LOG/g, log), { mode: 0o755 });
  return { path: bin, log };
}

test('run --json without --detach is a usage error, not a promise of JSON', async () => {
  const dir = await project(ONE_OP);
  const r = await run(['run', dir, '--json']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /--json requires --detach/);
  assert.match(r.err, /a foreground run streams logs/, 'the reason is named');
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
});

test('run --down --json says the two flags describe different things', async () => {
  const dir = await project(ONE_OP);
  const r = await run(['run', dir, '--down', '--json']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /--down only stops/);
});

test('run --detach --json prints one object and keeps the compose log off stdout', async () => {
  const dir = await project(ONE_OP.replace('ping', 'create').replace('-> string', '-> bool'));
  const fake = await fakeDocker(dir, '#!/bin/sh\nif [ "$1" = info ]; then echo "probe output"; exit 0; fi\necho "$@" >> LOG\necho "build output"\nexit 0\n');
  const before = process.env.PATH;
  process.env.PATH = fake.path + ':' + (before ?? '');
  let r: Result;
  try {
    r = await run(['run', dir, '--detach', '--json', '--scaffold']);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.mode, 'scaffold');
  assert.equal(report.url, 'http://localhost:' + report.port);
  assert.equal(report.port, 8080);
  assert.equal(report.stop, 'arcod run --down');
  assert.match(report.build, /\.arcod\/build$/);
  assert.equal(r.out.includes('arcod run:'), false, 'no prose on stdout: ' + r.out);
  assert.match(await readFile(fake.log, 'utf8'), /compose -f .* up --build -d/);
});

test('run --detach --json answers {error} when docker is missing', async () => {
  const dir = await project(ONE_OP.replace('ping', 'create').replace('-> string', '-> bool'));
  const empty = join(dir, 'empty-bin');
  await mkdir(empty);
  const before = process.env.PATH;
  process.env.PATH = empty;
  let r: Result;
  try {
    r = await run(['run', dir, '--detach', '--json', '--scaffold']);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(r.code, 1, r.err);
  const report = JSON.parse(r.out);
  assert.match(report.error, /docker is not running or unavailable/);
  assert.equal(r.err.includes('docker'), false, 'the message is the payload, not a stderr line');
});

test('run --detach --json answers the reference gap as data', async () => {
  const dir = await project(ONE_OP);
  const fake = await fakeDocker(dir, '#!/bin/sh\nif [ "$1" = info ]; then exit 0; fi\nexit 0\n');
  const before = process.env.PATH;
  process.env.PATH = fake.path + ':' + (before ?? '');
  let r: Result;
  try {
    r = await run(['run', dir, '--detach', '--json']);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(r.code, 1, r.err);
  const report = JSON.parse(r.out);
  assert.match(report.error, /demo handlers cover create and read only/);
  assert.deepEqual(report.missing, ['ping'], 'the operation without a demo body is named');
  assert.match(report.advice, /impl\/ping\.mjs/);
});

test('run --detach --json answers check errors with their diagnostics', async () => {
  const dir = await project(BROKEN);
  const fake = await fakeDocker(dir, '#!/bin/sh\nif [ "$1" = info ]; then exit 0; fi\nexit 0\n');
  const before = process.env.PATH;
  process.env.PATH = fake.path + ':' + (before ?? '');
  let r: Result;
  try {
    r = await run(['run', dir, '--detach', '--json']);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(r.code, 1, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.error, 'check failed');
  assert.equal(report.diagnostics.some((d: { code: string }) => d.code === 'A048'), true, r.out);
  assert.doesNotMatch(r.out, /^A048/m, 'diagnostics are data, not printed lines');
});
