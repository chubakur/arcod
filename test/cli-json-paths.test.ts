// Small, whole-command paths that no test walked: the JSON forms of plan and
// migrate, terraform on stdout (no --out), and `arcod impl` meeting a broken
// spec. Each is one line of output someone scripts against, and a silent change
// there is worse than a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

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
  console.log = (...args: unknown[]) => { out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

async function copyExample(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await cp(join(examplesDir, name), dir, { recursive: true });
  return dir;
}

test('plan --json prints the same plan the human form shows', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['plan', dir, '--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const parsed = JSON.parse(result.out) as { tasks?: unknown[] };
  assert.ok(Array.isArray(parsed.tasks) && parsed.tasks.length > 0, 'a plan carries tasks');
});

test('migrate --json is the machine form of the same run', async () => {
  const dir = await copyExample('tasks-sql');
  const result = await run(['migrate', dir, '--json']);
  assert.equal(result.code, 0, result.out + result.err);
  JSON.parse(result.out);
  // The human form ends with the artifact sentence; the JSON form must not
  // interleave it, or a parser chokes on the first line that is not JSON.
  assert.equal(/artifact: \.arcod\/build\/migrations/.test(result.out), false);
});

test('terraform without --out writes HCL to stdout', async () => {
  const dir = await copyExample('orders');
  const result = await run(['terraform', dir, '--env', 'prod']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /resource\s+"yandex_mdb_postgresql_cluster"/);
});

const BROKEN = [
  'module broken @0.1.0 {}',
  'service S : http {',
  '  roles: user',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/list"',
  '      roles: admin',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

test('impl refuses a broken spec before it spends a model call', async () => {
  const dir = await copyExample('tasks');
  await writeFile(join(dir, 'main.arc'), BROKEN, 'utf8');
  const result = await run(['impl', dir]);
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /A048/, 'the role that was never declared is named');
});

// The reference gap — no demo body for an operation the create/read templates
// do not cover — used to answer --json with two prose lines and an empty stdout.
// Every other failure above is data, so this one is too.
async function bareExample(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await cp(join(examplesDir, 'tasks-sql', 'main.arc'), join(dir, 'main.arc'));
  return dir;
}

test('build --json reports the reference gap as data', async () => {
  const dir = await bareExample();
  const result = await run(['build', dir, '--reference', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '', 'a parser reads stdout; the failure is not prose');
  const parsed = JSON.parse(result.out) as { error?: string; missing?: string[]; advice?: string };
  assert.match(parsed.error ?? '', /^no operation bodies to build: --reference covers only create and read\.$/);
  assert.deepEqual(parsed.missing, ['list', 'move'], 'the operations without a body are named');
  assert.match(parsed.advice ?? '', /impl\/list\.mjs/);
});

test('test --json keeps the report shape when the reference gap stops it', async () => {
  const dir = await bareExample();
  const result = await run(['test', dir, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '');
  const parsed = JSON.parse(result.out) as { examples?: unknown[]; rules?: unknown[]; missing?: string[]; advice?: string };
  assert.deepEqual(parsed.examples, [], 'a failed run is still an empty report');
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(parsed.missing, ['list', 'move']);
  assert.match(parsed.advice ?? '', /arcod impl/);
});


// A spec that does not check stops build before anything is emitted. The
// diagnostics used to go to stdout as prose even under --json, so a CI gate
// that parsed the output got an empty report and a printed hint.
test('build --json answers check errors with their diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await writeFile(join(dir, 'main.arc'), [
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
  ].join(String.fromCharCode(10)), 'utf8');
  const result = await run(['build', dir, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.err, '', 'the failure is data, not a printed line');
  const parsed = JSON.parse(result.out) as { error?: string; diagnostics?: Array<{ code: string; message: string }> };
  assert.equal(parsed.error, 'check failed');
  assert.deepEqual((parsed.diagnostics ?? []).map((d) => d.code), ['A046', 'A048']);
  assert.match(parsed.diagnostics?.[0]?.message ?? '', /identity capability/);
});


// The shared refusal: every command that reads a contract answers the same
// object when the spec does not check. migrate, prompts and impl printed prose
// under --json while build and test already answered data.
test('migrate, prompts and impl answer check errors as the shared object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  await writeFile(join(dir, 'main.arc'), [
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
  ].join(String.fromCharCode(10)), 'utf8');
  for (const command of ['migrate', 'prompts', 'impl']) {
    const result = await run([command, dir, '--json']);
    assert.equal(result.code, 1, command + ': ' + result.out + result.err);
    assert.equal(result.err, '', command + ' prints no prose');
    const parsed = JSON.parse(result.out) as { error?: string; diagnostics?: Array<{ code: string }> };
    assert.equal(parsed.error, 'check failed', command);
    assert.deepEqual((parsed.diagnostics ?? []).map((d) => d.code), ['A046', 'A048'], command);
  }
});


// deploy --json used to answer an empty stdout and a prose reason on stderr for
// every refusal: no environment, no target in the environment, unknown
// provider. A caller that parses the manifest got nothing at all.
test('deploy --json answers its three refusals as {error}', async () => {
  const cases: Array<{ spec: string[]; env?: string; match: RegExp }> = [
    { spec: ['module m @0.1.0 {}', 'service S : http {', '  contract {', '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}'], match: /no environment to deploy/ },
    { spec: ['module m @0.1.0 {}', 'environment prod {', '}', 'service S : http {', '  contract {', '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}'], match: /declares no deploy target/ },
    { spec: ['module m @0.1.0 {}', 'environment prod {', '  deploy nope', '}', 'service S : http {', '  contract {', '    public op ping() -> string { route: "GET /v1/ping" }', '  }', '}'], match: /unknown deploy provider nope/ },
  ];
  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
    await writeFile(join(dir, 'main.arc'), item.spec.join(String.fromCharCode(10)), 'utf8');
    const result = await run(['deploy', dir, '--json']);
    assert.equal(result.code, 1, item.match + ': ' + result.out + result.err);
    assert.equal(result.err, '', 'the reason is not a stderr line: ' + result.err);
    const parsed = JSON.parse(result.out) as { error?: string };
    assert.match(parsed.error ?? '', item.match);
  }
});


// A spec that does not parse is a refusal too, and --json is the machine
// surface: every command used to answer with an empty stdout and a prose line
// on stderr, so a script had to parse the one shape the compiler refused to
// give it. The object is the same {error, diagnostics} check uses.
test('a spec that does not parse answers {error} under --json, for every command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  const file = join(dir, 'broken.arc');
  await writeFile(file, ['module broken @0.1.0 {', '  service {'].join(String.fromCharCode(10)), 'utf8');
  for (const command of ['check', 'plan', 'build', 'test', 'migrate', 'prompts', 'impl']) {
    const result = await run([command, file, '--json']);
    assert.equal(result.code, 1, command + ' fails a spec that does not parse');
    assert.equal(result.err, '', command + ' writes no prose to stderr: ' + result.err);
    const parsed = JSON.parse(result.out) as {
      error?: string;
      diagnostics?: Array<{ code: string; severity: string; file: string; message: string; range: { line: number; col: number } }>;
    };
    assert.equal(parsed.error, 'parse failed', command);
    const [found] = parsed.diagnostics ?? [];
    assert.ok(found, command + ' names the diagnostic');
    assert.equal(found.code, 'parse', command);
    assert.equal(found.severity, 'error', command);
    assert.equal(found.file, 'broken.arc', command);
    assert.equal(found.range.line, 2, command + ' points at the offending line');
    assert.match(found.message, /module header/, command);
  }
});

// The human form keeps its own contract: the location line goes to stderr and
// stdout stays empty, as the check tests already pin.
test('the human form still prints the parse failure on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  const file = join(dir, 'broken.arc');
  await writeFile(file, ['module broken @0.1.0 {', '  service {'].join(String.fromCharCode(10)), 'utf8');
  const result = await run(['check', file]);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /broken\.arc:2:3 {2}error {2}parse {2}/);
});


// The other half of load(): the path exists in the command line but not on
// disk. The message was already human ("cannot read <path>: ..."), but it
// reached stderr only, leaving stdout empty under --json.
test('a path that cannot be read answers {error} under --json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-json-'));
  const missing = join(dir, 'nope.arc');
  for (const command of ['check', 'plan', 'build', 'test', 'migrate', 'prompts', 'impl', 'deploy']) {
    const result = await run([command, missing, '--json']);
    assert.equal(result.code, 1, command + ' fails an unreadable path');
    assert.equal(result.err, '', command + ' keeps stderr clean');
    const parsed = JSON.parse(result.out) as { error?: string };
    assert.match(parsed.error ?? '', /^cannot read .*nope\.arc: no such file or directory$/, command);
  }
  const human = await run(['check', missing]);
  assert.equal(human.code, 1);
  assert.equal(human.out, '');
  assert.match(human.err, /^cannot read .*nope\.arc: no such file or directory$/m);
});


// A build refusal is a project mistake (exit 2), but --json is still the
// machine surface: two impl bodies declaring one top-level name answered a
// prose line on stderr and an empty stdout.
test('a build refusal answers {error} under --json and keeps exit 2', async () => {
  const dir = await copyExample('tasks-sql');
  for (const op of ['create', 'list']) {
    const file = join(dir, 'impl', op + '.mjs');
    await writeFile(file, (await readFile(file, 'utf8')) + String.fromCharCode(10) + 'const LINES = [];' + String.fromCharCode(10), 'utf8');
  }
  const result = await run(['build', dir, '--impl', '--json']);
  assert.equal(result.code, 2, 'a project mistake stays exit 2');
  assert.equal(result.err, '', 'the reason is not left on stderr');
  const parsed = JSON.parse(result.out) as { error?: string };
  assert.match(parsed.error ?? '', /duplicate top-level name "LINES"/);
  assert.match(parsed.error ?? '', /impl.create\.mjs and impl.list\.mjs/);
  const human = await run(['build', dir, '--impl']);
  assert.equal(human.code, 2);
  assert.equal(human.out, '');
  assert.match(human.err, /^arcod: duplicate top-level name "LINES"/m);
});
