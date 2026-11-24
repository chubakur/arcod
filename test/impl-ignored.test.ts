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

test('implIgnoredFiles: a project without impl/ has nothing to report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ignored-none-'));
  try {
    assert.deepEqual(await implIgnoredFiles(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
