// `arcod fmt` printed the absolute path for one file and a path relative to
// the caller over a pattern — two shapes for the same verdict, which a gate
// script had to know about. Both now answer with `specLabel`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { main } from '../src/cli.ts';
import { formatSource } from '../src/fmt.ts';

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

// A directory under the caller's cwd is the case the two modes disagreed on;
// a sibling of a temp dir would fall back to the absolute path in both.
async function fileInCwd(source: string): Promise<{ dir: string; label: string }> {
  const dir = await mkdtemp(join(process.cwd(), 'arcod-label-'));
  await writeFile(join(dir, 'main.arc'), source, 'utf8');
  return { dir, label: relative(process.cwd(), join(dir, 'main.arc')) };
}

test('one file --check prints the same relative label a pattern does', async () => {
  const { dir, label } = await fileInCwd(formatSource('module label @0.1.0 {}\n', 'main.arc'));
  try {
    const result = await run(['fmt', join(dir, 'main.arc'), '--check']);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, label + ': ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--write names the file the same way', async () => {
  const { dir, label } = await fileInCwd('module   label   @0.1.0 {}\n');
  try {
    const result = await run(['fmt', join(dir, 'main.arc'), '--write']);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, 'formatted ' + label);
    assert.equal(await readFile(join(dir, 'main.arc'), 'utf8'), formatSource('module label @0.1.0 {}\n', 'main.arc'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
