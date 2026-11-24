// The build bundles only impl/*.mjs, so a body saved as impl/totals.js was
// invisible: check saw no body and the route answered 501 at request time.
// W051 names the skipped file and the extension the build reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { implIgnoredFiles } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';
import { main } from '../src/cli.ts';

const SPEC = `module ignored @0.1.0 {
  meta {
    owner: "@test"
    status: "draft"
    since: "2026-11-24"
  }
}

use capability arcod.std.sql @1

type Line = { id: string, amount: int }

service Lines : http {
  uses store: sql

  effects {
    allow store.aggregate
  }

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      effects: store.aggregate
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`;

function w051(ignored: string[] | undefined) {
  return check(parse(SPEC, 'main.arc'), { implIgnored: ignored }).filter((item) => item.code === 'W051');
}

test('W051: a .js body is named as not bundled, with the extension to use', () => {
  const found = w051(['totals.js']);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.equal(found[0].file, 'impl/totals.js');
  assert.match(found[0].message, /impl\/totals\.js is not a \.mjs body/);
  assert.match(String(found[0].hint), /impl\/<operation>\.mjs/);
});

test('W051: no skipped files, no warning', () => {
  assert.deepEqual(w051(undefined), []);
  assert.deepEqual(w051([]), []);
});

test('implIgnoredFiles lists only files the build will not read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-'));
  try {
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'totals.mjs'), 'export async function totals(input, io) { return { result: 1 }; }\n');
    await writeFile(join(dir, 'impl', 'totals.js'), 'module.exports = {};\n');
    await writeFile(join(dir, 'impl', '.hidden.js'), 'x\n');
    await mkdir(join(dir, 'impl', 'nested'));
    assert.deepEqual(await implIgnoredFiles(dir), ['totals.js']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The wiring is part of the fix: check knows only the names the caller passes,
// so the CLI has to ask the build which files it skipped. A check-level test
// alone would pass while `arcod check` stayed silent.
test('arcod check reports W051 for a body the build cannot read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-cli-'));
  const out: string[] = [];
  const realLog = console.log;
  try {
    await writeFile(join(dir, 'main.arc'), SPEC);
    await mkdir(join(dir, 'impl'));
    await writeFile(join(dir, 'impl', 'totals.js'), 'export async function totals(input, io) { return { result: 1 }; }\n');
    console.log = (...args: unknown[]) => { out.push(args.map((a) => String(a)).join(' ')); };
    await main(['check', dir]);
  } finally {
    console.log = realLog;
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
  const text = out.join('\n');
  assert.match(text, /impl\/totals\.js:1:1 {2}warning {2}W051/);
  assert.match(text, /rename it to impl\/<operation>\.mjs/);
});

test('implIgnoredFiles: a project without impl/ has nothing to report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-none-'));
  try {
    assert.deepEqual(await implIgnoredFiles(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// readImpl reads impl/ one level deep, so a body filed under a subdirectory was
// dropped without a word -- and with no top-level body the W050 pass stays quiet
// too (the map is empty), so the project looked complete. W051 names the
// directory and the number of bodies the build never reads.
test('W051: a directory of bodies is named with the number inside it', async () => {
  const { implIgnoredDirs } = await import('../src/build.ts');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-dir-'));
  try {
    await mkdir(join(dir, 'impl', 'ops'), { recursive: true });
    await writeFile(join(dir, 'impl', 'ops', 'a.mjs'), 'export async function a(input, io) { return 1; }\n');
    await writeFile(join(dir, 'impl', 'ops', 'b.mjs'), 'export async function b(input, io) { return 2; }\n');
    await mkdir(join(dir, 'impl', 'empty'));
    await mkdir(join(dir, 'impl', '.cache'));
    await writeFile(join(dir, 'impl', '.cache', 'x.mjs'), 'x\n');
    assert.deepEqual(await implIgnoredDirs(dir), [{ name: 'ops', bodies: 2 }]);

    const found = check(parse(SPEC, 'main.arc'), { implIgnoredDirs: [{ name: 'ops', bodies: 2 }] })
      .filter((item) => item.code === 'W051');
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'warning');
    assert.equal(found[0].file, 'impl/ops/');
    assert.match(found[0].message, /impl\/ops\/ holds 2 \.mjs bodies the build never reads/);
    assert.match(String(found[0].hint), /move each body up to impl\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('W051: one body in a directory is singular, and a file list still works', () => {
  const found = check(parse(SPEC, 'main.arc'), {
    implIgnored: ['totals.js'],
    implIgnoredDirs: [{ name: 'lib', bodies: 1 }],
  }).filter((item) => item.code === 'W051');
  assert.equal(found.length, 2);
  assert.match(found.map((item) => item.message).join('\n'), /impl\/lib\/ holds 1 \.mjs body the build never reads/);
});

// The wiring matters as much as the wording: check knows only what the caller
// asks the build for, so the CLI must pass both lists.
test('arcod check reports W051 for a nested body directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-dir-cli-'));
  const out: string[] = [];
  const realLog = console.log;
  try {
    await writeFile(join(dir, 'main.arc'), SPEC);
    await mkdir(join(dir, 'impl', 'ops'), { recursive: true });
    await writeFile(join(dir, 'impl', 'ops', 'totals.mjs'), 'export async function totals(input, io) { return { result: 1 }; }\n');
    console.log = (...args: unknown[]) => { out.push(args.map((a) => String(a)).join(' ')); };
    await main(['check', dir]);
  } finally {
    console.log = realLog;
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
  const text = out.join('\n');
  assert.match(text, /impl\/ops\/:1:1 {2}warning {2}W051 {2}impl\/ops\/ holds 1 \.mjs body/);
});
