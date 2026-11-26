// A module with several services files each body under its service (B109):
// impl/<service>/<op>.mjs. The build used to read impl/ one level deep, so a
// per-service body was invisible -- the route answered 501 while the file sat
// next to the spec. These tests pin the reader, the ignored-directory report
// and the duplicate refusal (A107).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample, implDuplicatesFor, implIgnoredDirs, implScanFor } from '../src/build.ts';
import { check } from '../src/check.ts';
import { parse } from '../src/parser.ts';
import { main } from '../src/cli.ts';

const SPEC = `module shop @0.1.0 {}

type Item = { id: string, title: string }

service Store : http {
    uses db: kv
    contract {
      public op create(title: string) -> Item {
        route: "POST /v1/items"
      }
    }
  }
`;

const BODY = 'export async function create(input, io) {\n  return { id: "FROM-SERVICE-DIR", title: input.title };\n}\n';

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-service-body-'));
  await writeFile(join(dir, 'main.arc'), SPEC);
  return dir;
}

test('build: a body under impl/<service>/ is bundled', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    const result = await buildExample(parse(SPEC, 'main.arc'), dir, { port: 8080 });
    const emitted = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    assert.match(emitted, /FROM-SERVICE-DIR/);
    assert.deepEqual(result.impl, ['create']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('implIgnoredDirs: a folder named after a service is read, not ignored', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    await mkdir(join(dir, 'impl', 'ops'), { recursive: true });
    await writeFile(join(dir, 'impl', 'ops', 'create.mjs'), BODY);
    // Without the service names ops and Store are the same shape, so both look
    // ignored: the caller has to say which names are services.
    const all = await implIgnoredDirs(dir);
    assert.deepEqual(all.map((item) => item.name).sort(), ['Store', 'ops']);
    assert.deepEqual(all.map((item) => item.bodies), [1, 1]);
    assert.deepEqual(await implIgnoredDirs(dir, ['Store']), [{ name: 'ops', bodies: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('A107: one operation with two bodies is named with both files', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'create.mjs'), BODY);
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    assert.deepEqual(await implDuplicatesFor(dir, ['Store']), [
      { op: 'create', files: ['impl/Store/create.mjs', 'impl/create.mjs'] },
    ]);
    const diags = check(parse(SPEC, 'main.arc'), { implDuplicates: await implDuplicatesFor(dir, ['Store']) })
      .filter((item) => item.code === 'A107');
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.equal(diags[0].file, 'impl/Store/create.mjs');
    assert.match(diags[0].message, /operation create has two bodies: impl\/Store\/create\.mjs and impl\/create\.mjs/);
    assert.match(String(diags[0].hint), /one body per operation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build: the same operation in two bodies is refused, not ordered', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'create.mjs'), BODY);
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    await assert.rejects(
      buildExample(parse(SPEC, 'main.arc'), dir, { port: 8080 }),
      /operation create has two bodies: impl\/Store\/create\.mjs and impl\/create\.mjs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('implScanFor: a service folder body counts as the operation body', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    const scan = await implScanFor(dir, ['Store']);
    assert.deepEqual(Object.keys(scan.bodies ?? {}), ['create']);
    assert.deepEqual(scan.duplicates, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('arcod check reports A107 for a duplicate body', async () => {
  const dir = await project();
  const out: string[] = [];
  const realLog = console.log;
  try {
    await mkdir(join(dir, 'impl', 'Store'), { recursive: true });
    await writeFile(join(dir, 'impl', 'create.mjs'), BODY);
    await writeFile(join(dir, 'impl', 'Store', 'create.mjs'), BODY);
    console.log = (...args: unknown[]) => { out.push(args.map((a) => String(a)).join(' ')); };
    await main(['check', dir]);
  } finally {
    console.log = realLog;
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
  const text = out.join('\n');
  assert.match(text, /impl\/Store\/create\.mjs:1:1 {2}error {2}A107 {2}operation create has two bodies/);
});
