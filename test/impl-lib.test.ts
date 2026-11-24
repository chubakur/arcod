// Bodies are concatenated into one module, so a helper had to live in a body
// and be duplicated (issue #39: "duplicate top-level name subjectHash in
// create.mjs and seed.mjs"). impl/lib.mjs is bundled once before the bodies:
// every body sees its functions as top level, and the shared namespace is what
// the collision scan and the sandbox already guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildExample, implBodiesFor, implLibFor } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';

const run = promisify(execFile);

const SPEC = `module libdemo @0.1.0 {
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
    allow store.aggregate, store.count
  }

  contract {
    public op totals() -> int {
      route: "GET /v1/totals"
      effects: store.aggregate
      post: result != null
    }

    public op count() -> int {
      route: "GET /v1/count"
      effects: store.count
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  deploy docker
}
`;

const TOTALS = 'export async function totals(input, io) { return double(1); }\n';
const COUNT = 'export async function count(input, io) { return double(2); }\n';
const LIB = 'export function double(n) { return n * 2; }\n';

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-lib-'));
  await writeFile(join(dir, 'main.arc'), SPEC);
  await mkdir(join(dir, 'impl'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, 'impl', name), body);
  return dir;
}

test('impl/lib.mjs is bundled once and both bodies call it', async () => {
  const dir = await project({ 'lib.mjs': LIB, 'totals.mjs': TOTALS, 'count.mjs': COUNT });
  try {
    assert.equal(await implLibFor(dir), LIB);
    // lib.mjs is the shared module, not the body of an operation called lib.
    assert.deepEqual(Object.keys((await implBodiesFor(dir)) ?? {}).sort(), ['count', 'totals']);
    const built = await buildExample(parse(SPEC, 'main.arc'), dir);
    const js = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
    assert.equal((js.match(/function double\(/g) ?? []).length, 1, 'the helper is emitted once');
    assert.match(js, /\/\/ impl\/lib\.mjs/);
    // The bodies are concatenated after the lib, so the helper is in scope for
    // both -- and the module still parses as one file.
    await run(process.execPath, ['--check', join(built.dir, 'service', 'index.mjs')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a body that redeclares a lib helper is refused, with both files named', async () => {
  const dir = await project({ 'lib.mjs': LIB, 'totals.mjs': 'export async function totals(input, io) { return 1; }\nfunction double(n) { return n; }\n' });
  try {
    const impl = await implBodiesFor(dir);
    const lib = await implLibFor(dir);
    await assert.rejects(
      () => buildExample(parse(SPEC, 'main.arc'), dir),
      (error: any) => {
        assert.match(String(error.message), /duplicate top-level name "double"/);
        assert.match(String(error.message), /impl\/lib\.mjs/);
        assert.match(String(error.message), /impl\/totals\.mjs/);
        return true;
      },
    );
    const found = check(parse(SPEC, 'main.arc'), { impl, implLib: lib }).filter((item) => item.code === 'A093');
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'impl/totals.mjs');
    assert.match(found[0].message, /impl\/lib\.mjs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lib.mjs is not an orphan body: no W049 for it', async () => {
  const dir = await project({ 'lib.mjs': LIB, 'totals.mjs': TOTALS });
  try {
    const diags = check(parse(SPEC, 'main.arc'), {
      impl: await implBodiesFor(dir),
      implLib: await implLibFor(dir),
    });
    assert.deepEqual(diags.filter((item) => item.code === 'W049'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the lib is held to the body sandbox', async () => {
  const dir = await project({ 'lib.mjs': 'import { readFile } from "node:fs/promises";\nexport async function double() { return 1; }\n', 'totals.mjs': TOTALS });
  try {
    await assert.rejects(
      () => buildExample(parse(SPEC, 'main.arc'), dir),
      /impl\/lib\.mjs violates the sandbox/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A caller may name the impl directory itself (build --impl, the test harness,
// a body map written elsewhere), and the lib lives inside it. Reading lib from
// <exampleDir>/impl/lib.mjs regardless made such a build emit a body that calls
// an undefined helper -- the service started and answered 500.
test('build --impl reads lib.mjs from the named impl directory', async () => {
  const dir = await project({ 'lib.mjs': LIB, 'totals.mjs': TOTALS, 'count.mjs': COUNT });
  try {
    const built = await buildExample(parse(SPEC, 'main.arc'), join(dir, 'elsewhere'), { implDir: join(dir, 'impl') });
    const js = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
    assert.equal((js.match(/function double\(/g) ?? []).length, 1, 'the helper comes from the named directory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
