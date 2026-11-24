// The module header names the language version, and nothing read it: a spec
// declaring `@9.9.9` was reported clean by `check` and scaffolded by `build`
// with 0.1.0 semantics, while `arcod upgrade` called the same file "unknown
// language version". A version the compiler does not know means the spec may
// rely on rules the emitters never implement, so check refuses it (A098) and
// points at the token. A header with no `@version` keeps the old answer: the
// parser defaults to 0.0.0 and there is nothing to contradict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { main } from '../src/cli.ts';

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

const UNKNOWN = 'module bad @9.9.9 {}\n\ntype T = { id: uuid }\n';
const KNOWN = 'module good @0.1.0 {}\n\ntype T = { id: uuid }\n';
const NO_VERSION = 'module plain {}\n\ntype T = { id: uuid }\n';

test('check refuses a language version the compiler does not know', () => {
  const mod = parse(UNKNOWN, 'main.arc');
  const errors = check(mod).filter((d) => d.severity === 'error');
  assert.equal(errors.length, 1, 'one error, not a cascade');
  assert.equal(errors[0].code, 'A098');
  assert.equal(errors[0].path, 'module.version');
  assert.match(errors[0].message, /unknown language version 9\.9\.9/);
  assert.match(errors[0].hint ?? '', /0\.1\.0/, 'the hint names the version this compiler knows');
  // The diagnostic points at the `@9.9.9` token on line 1, not at the module.
  assert.equal(errors[0].range.line, 1);
  assert.equal(errors[0].range.col, UNKNOWN.indexOf('@') + 1);
});

test('a known version and a header without one stay clean', () => {
  assert.deepEqual(check(parse(KNOWN, 'main.arc')).filter((d) => d.severity === 'error'), []);
  const plain = parse(NO_VERSION, 'plain.arc');
  assert.equal(plain.versionLoc, undefined, 'no @token, nothing to point at');
  assert.deepEqual(check(plain).filter((d) => d.severity === 'error'), []);
});

test('check exits 1 and names A098 on the command line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-version-'));
  const file = join(dir, 'main.arc');
  await writeFile(file, UNKNOWN, 'utf8');
  const result = await run(['check', file]);
  assert.equal(result.code, 1);
  // A report is the payload of `check`, so it goes to stdout; the CLI keeps
  // stderr for its own refusals.
  assert.match(result.out, /A098\s+unknown language version 9\.9\.9/);
  assert.match(result.out, /1 error\(s\)/);
  assert.equal(await readFile(file, 'utf8'), UNKNOWN, 'check never rewrites the spec');
});

test('build refuses the same spec instead of scaffolding 0.1.0 semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-version-build-'));
  await cp(new URL('../examples/notes-ssr', import.meta.url), join(dir, 'notes-ssr'), { recursive: true });
  const file = join(dir, 'notes-ssr', 'main.arc');
  const source = await readFile(file, 'utf8');
  await rm(join(dir, 'notes-ssr', '.arcod'), { recursive: true, force: true });
  await writeFile(file, source.replace('@0.1.0', '@9.9.9'), 'utf8');
  const result = await run(['build', file]);
  assert.equal(result.code, 1);
  assert.match(result.out, /A098/);
  await assert.rejects(stat(join(dir, 'notes-ssr', '.arcod', 'build')), 'no build directory is written');
});
