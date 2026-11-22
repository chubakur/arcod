// A spec the process cannot read used to answer with Node's syscall text
// ("EACCES: permission denied, open '...'") out of load(), and a directory it
// could not list answered "no .arc file found in <dir>" — sending the user to
// look for a missing spec that is already there. Both now say what happened.
// The exit code is checked through the real entry point, since the message is
// printed by main()'s top-level catch and not by a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);
const NL = String.fromCharCode(10);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/arcod.mjs', ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('an unreadable spec says permission denied, not EACCES', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-read-'));
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module read @0.1.0 {}' + NL, 'utf8');
  await chmod(file, 0o000);
  try {
    const result = await runCli(['check', file]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'cannot read ' + file + ': permission denied');
  } finally {
    await chmod(file, 0o644);
  }
});

test('an unreadable directory is not reported as having no spec', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-read-'));
  await writeFile(join(dir, 'main.arc'), 'module read @0.1.0 {}' + NL, 'utf8');
  await chmod(dir, 0o000);
  try {
    const result = await runCli(['check', dir]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'cannot read ' + dir + ': permission denied');
  } finally {
    await chmod(dir, 0o755);
  }
});

test('an explicit spec under an unsearchable directory names the permission, not a typo', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-read-'));
  const file = join(dir, 'main.arc');
  await writeFile(file, 'module read @0.1.0 {}' + NL, 'utf8');
  await chmod(dir, 0o000);
  try {
    // stat() cannot tell "there is no such file" from "I may not look", so a
    // path inside a directory without +x used to fall into the typo branch and
    // advise the user to check a path that is spelled correctly.
    const result = await runCli(['check', file]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'cannot read ' + file + ': permission denied');
    assert.doesNotMatch(result.stderr, /ENOENT|no such file/, 'the file is there; the directory is not searchable');
  } finally {
    await chmod(dir, 0o755);
  }
});

test('check over a pattern reports an unreadable file without EACCES', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-read-'));
  const good = join(dir, 'a.arc');
  const locked = join(dir, 'b.arc');
  await writeFile(good, 'module a @0.1.0 {}' + NL, 'utf8');
  await writeFile(locked, 'module b @0.1.0 {}' + NL, 'utf8');
  await chmod(locked, 0o000);
  try {
    const result = await runCli(['check', join(dir, '*.arc')]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /a\.arc: ok/);
    assert.match(result.stdout, /b\.arc  error  permission denied/);
    assert.equal(result.stdout.includes('EACCES'), false, 'no syscall text in a per-file report');
    assert.match(result.stdout, /2 file\(s\), 1 with errors/);
  } finally {
    await chmod(locked, 0o644);
  }
});
