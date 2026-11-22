// A quoted pattern may name directories, not only spec files: `arcod check
// 'projects/*'` is how a workspace of projects is checked in one go. The walk
// had a branch that looked for main.arc inside each matched directory and no
// test reached it — the pattern tests all ended in /main.arc. A directory
// without a spec must be skipped silently; a broken project must be reported
// by path while the other projects still run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const GOOD = 'module good @0.1.0 {}';
const BROKEN = [
  'module broken @0.1.0 {}',
  'service S : http {',
  '  roles: user',
  '  contract {',
  '    public op list() -> bool {',
  '      route: "GET /v1/list"',
  '      roles: user',
  '    }',
  '  }',
  '}',
].join('\n');

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

test('a pattern of directories checks each project it finds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dirs-'));
  await mkdir(join(root, 'one'));
  await mkdir(join(root, 'two'));
  await mkdir(join(root, 'empty'));
  await writeFile(join(root, 'one', 'main.arc'), GOOD, 'utf8');
  await writeFile(join(root, 'two', 'main.arc'), GOOD, 'utf8');
  const result = await run(['check', join(root, '*')]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /one[\\/]main\.arc/);
  assert.match(result.out, /two[\\/]main\.arc/);
  assert.equal(result.out.includes('empty'), false, 'a directory without a spec is not a report');
});

test('a trailing ** finds the spec of every project below a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dirs-'));
  await mkdir(join(root, 'one'), { recursive: true });
  await mkdir(join(root, 'deep', 'two'), { recursive: true });
  await mkdir(join(root, 'deep', 'three', 'four'), { recursive: true });
  await writeFile(join(root, 'one', 'main.arc'), GOOD, 'utf8');
  await writeFile(join(root, 'deep', 'two', 'main.arc'), GOOD, 'utf8');
  await writeFile(join(root, 'deep', 'three', 'four', 'main.arc'), GOOD, 'utf8');
  const result = await run(['check', join(root, '**')]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /one[\\/]main\.arc/);
  assert.match(result.out, /two[\\/]main\.arc/);
  assert.match(result.out, /four[\\/]main\.arc/, 'the walk descends more than one level');
});

test('** in the middle still names files at any depth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dirs-'));
  await mkdir(join(root, 'deep', 'two'), { recursive: true });
  await writeFile(join(root, 'main.arc'), GOOD, 'utf8');
  await writeFile(join(root, 'deep', 'two', 'main.arc'), GOOD, 'utf8');
  const result = await run(['check', join(root, '**', 'main.arc')]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /two[\\/]main\.arc/);
  assert.match(result.out, new RegExp(root.split('/').pop() + '[\\\\/]main\\.arc'), 'the zero-level match is kept');
});

test('one broken project does not stop the others', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arcod-dirs-'));
  await mkdir(join(root, 'bad'));
  await mkdir(join(root, 'ok'));
  await writeFile(join(root, 'bad', 'main.arc'), BROKEN, 'utf8');
  await writeFile(join(root, 'ok', 'main.arc'), GOOD, 'utf8');
  const result = await run(['check', join(root, '*')]);
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /A048/);
  assert.match(result.out, /ok[\\/]main\.arc/);
});
