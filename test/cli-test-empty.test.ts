// `arcod test` on a project with nothing to run: the report is empty, and an
// empty report is still a report. The text form says so in one line; the JSON
// form must stay parseable — a caller that pipes stdout into a parser must not
// get prose, which is why the branch checks --json first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const SPEC = [
  'module quiet @0.1.0 {',
  '}',
  '',
  'service Notes : http {',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/notes"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-quiet-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  return dir;
}

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
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

test('arcod test with no examples or rules says so in one line', async () => {
  const dir = await project();
  const result = await run(['test', join(dir, 'main.arc')]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /^no examples or rules declared$/m);
});

test('arcod test --json keeps stdout a JSON report when it is empty', async () => {
  const dir = await project();
  const result = await run(['test', join(dir, 'main.arc'), '--json']);
  assert.equal(result.code, 0, result.out + result.err);
  const report = JSON.parse(result.out) as { examples: unknown[]; rules: unknown[] };
  assert.deepEqual(report.examples, []);
  assert.deepEqual(report.rules, []);
});


// The same promise on the failure path: a spec that does not pass check has no
// report to print, but a --json caller still gets JSON (the diagnostics), not
// the human diagnostic lines.
test('arcod test --json stays JSON when the spec fails check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-quiet-'));
  await writeFile(join(dir, 'main.arc'), [
    'module quiet @0.1.0 {',
    '}',
    '',
    'type Weird = float128',
    '',
    'service Notes : http {',
    '  contract {',
    '    public op list() -> bool {',
    '      route: "GET /v1/notes"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  const result = await run(['test', join(dir, 'main.arc'), '--json']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out) as { examples: unknown[]; rules: unknown[]; diagnostics: Array<{ code: string }> };
  assert.deepEqual(report.examples, []);
  assert.deepEqual(report.rules, []);
  assert.equal(report.diagnostics[0].code, 'A088');
});
