// An invariant v0.1 cannot execute used to disappear: `check` was clean and
// `arcod test` printed a green summary, so a typo (`oncee(...)`) turned the
// rule into a comment. These tests pin the two halves of the fix: W040 in
// `check` and a `skip` row (counted apart) in `test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { main } from '../src/cli.ts';

const service = (rule: string): string => [
  'module rules @0.1.0 {',
  '}',
  '',
  'type Note = { id: string, text: string }',
  '',
  'error NotFound',
  'error Gone',
  '',
  'service Notes : http {',
  '  uses store: kv',
  '  rules {',
  '    ' + rule,
  '  }',
  '  contract {',
  '    public op read(id: string) -> Note {',
  '      route: "GET /v1/notes/:id"',
  '      errors: NotFound, Gone',
  '    }',
  '  }',
  '}',
].join('\n');

function diagnostics(source: string, code: string) {
  return check(parse(source, 'rules.arc')).filter((diag) => diag.code === code);
}

test('W040: a misspelled predicate is reported, not dropped', () => {
  const found = diagnostics(service('invariant read.at_most_once: oncee(read, by: id, else: Gone)'), 'W040');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /oncee\(\.\.\.\)/);
  assert.match(found[0].message, /not executed by arcod test/);
  assert.equal(found[0].path, 'services.Notes.rules.read.at_most_once');
});

test('W040: a predicate v0.1 does not run is named as written', () => {
  const found = diagnostics(service('invariant read.unique_key: unique(read, by: id)'), 'W040');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unique\(\.\.\.\)/);
});

test('no W040 for the executable once(...) form', () => {
  const source = service('invariant read.at_most_once: once(read, by: id, else: Gone)');
  assert.deepEqual(diagnostics(source, 'W040'), []);
  assert.deepEqual(diagnostics(source, 'A022'), []);
});

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

test('test prints an unexecuted invariant as skip and stays green', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-rules-skip-'));
  await cp(new URL('../examples/onetimemessage', import.meta.url), dir, { recursive: true });
  const spec = join(dir, 'main.arc');
  const source = await readFile(spec, 'utf8');
  assert.match(source, /once\(read, by: id, else: Gone\)/);
  await writeFile(spec, source.replace('once(read, by: id, else: Gone)', 'oncee(read, by: id, else: Gone)'), 'utf8');

  const human = await run(['test', spec]);
  assert.equal(human.code, 0, human.out + human.err);
  assert.match(human.out, /skip +read\.at_most_once/);
  assert.match(human.out, /1 skipped/);
  assert.match(human.out, /\d+ passed, 0 failed, 1 skipped/);
  assert.doesNotMatch(human.out, /^  fail/m);

  const json = await run(['test', spec, '--json']);
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out) as { rules: Array<{ rule: string; ok: boolean; skipped?: boolean; detail?: string }> };
  const skipped = report.rules.filter((rule) => rule.skipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].rule, 'read.at_most_once');
  assert.equal(skipped[0].ok, true);
  assert.match(skipped[0].detail ?? '', /once only/);
});
