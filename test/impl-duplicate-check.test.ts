// Two impl/*.mjs bodies are concatenated into one module. A helper declared in
// both files is a SyntaxError that used to surface only when the container
// started: check said nothing and `build --impl` was the first place the
// duplicate appeared. check has the same bodies in hand, so the diagnostic
// names both files and the build keeps refusing the same collision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { check } from '../src/check.ts';
import { main } from '../src/cli.ts';
import { parse } from '../src/parser.ts';

const SPEC = `module dup @0.1.0 {
  meta {
    owner: \"@test\"
    status: \"draft\"
    since: \"2026-11-23\"
  }
}

use capability arcod.std.sql @1
use capability arcod.std.ids @1

type ItemId = uuid
type Item = { id: ItemId, label: string }

service Items : http {
  uses store: sql
  uses uuid: ids

  effects {
    allow store.insert, uuid.new
  }

  contract {
    public op create(label: string) -> Item {
      route: \"POST /v1/items\"
      effects: store.insert, uuid.new
      post: result != null
    }

    public op seed(label: string) -> Item {
      route: \"POST /v1/items/seed\"
      effects: store.insert, uuid.new
      post: result != null
    }
  }
}

environment dev {
  bind store -> mysql
  bind uuid -> local
  deploy docker
}
`;

// One helper, one name, in two bodies: the concatenated module declares it twice.
const BODY = (name: string) =>
  'export async function ' + name + '(input, io) {\n' +
  '  return { id: io.new(), label: subjectHash(String(input.label || \'\')) };\n' +
  '}\n' +
  'function subjectHash(text) {\n' +
  '  return text.trim();\n' +
  '}\n';

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-dup-'));
  await writeFile(join(dir, 'main.arc'), SPEC);
  await mkdir(join(dir, 'impl'));
  await writeFile(join(dir, 'impl', 'create.mjs'), BODY('create'));
  await writeFile(join(dir, 'impl', 'seed.mjs'), BODY('seed'));
  return dir;
}

test('check reports a helper declared in two bodies with both file names', async () => {
  const dir = await project();
  try {
    const impl = { create: BODY('create'), seed: BODY('seed') };
    const diags = check(parse(SPEC, 'main.arc'), { impl });
    const found = diags.filter((item) => item.code === 'A093');
    assert.equal(found.length, 1, 'one collision, one diagnostic: ' + diags.map((item) => item.code).join(','));
    assert.equal(found[0].severity, 'error');
    assert.match(found[0].message, /duplicate top-level name \"subjectHash\"/);
    assert.match(found[0].message, /impl\/create\.mjs/);
    assert.match(found[0].message, /impl\/seed\.mjs/);
    // The location is the second declaration, inside impl/seed.mjs line 4.
    assert.equal(found[0].file, 'impl/seed.mjs');
    assert.equal(found[0].range.line, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('arcod check refuses the duplicate before any build is started', async () => {
  const dir = await project();
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => { out.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  try {
    await main(['check', dir]);
    const text = out.join('\n') + err.join('\n');
    // check refuses with exit 1, like every other contract error it reports.
    assert.equal(Number(process.exitCode ?? 0), 1, text);
    assert.match(text, /A093/);
    assert.match(text, /impl\/create\.mjs/);
    // The location is printed against the body it lives in, not the spec: the
    // line number belongs to impl/seed.mjs.
    assert.match(text, /^impl\/seed\.mjs:4:1  error  A093/m);
    // check reads the spec and the bodies; it never writes a build tree.
    await assert.rejects(stat(join(dir, '.arcod')), 'check leaves no .arcod behind');
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the build refuses the same collision with the same words', async () => {
  const dir = await project();
  try {
    await assert.rejects(
      buildExample(parse(SPEC, 'main.arc'), dir, { implDir: join(dir, 'impl') }),
      /duplicate top-level name \"subjectHash\" in impl\/create\.mjs and impl\/seed\.mjs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
