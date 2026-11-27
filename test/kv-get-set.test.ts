// B91: a body got io.load/io.save and had to know the record envelope { b, h }
// and the 'msg:' key prefix — neither was documented. io.get/io.set put the
// value itself in and out; these tests run a generated service and prove the
// round trip for an object and a scalar, and that the old pair still reads what
// it wrote.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { runExamples } from '../src/test.ts';

const spec = `module cache @0.1.0 {}

use capability arcod.std.kv @1

service Cache : http {
  uses store: kv

  contract {
    public op put(key: string, text: string) -> string {
      route: "POST /v1/put"
    }
    public op read(key: string) -> string {
      route: "GET /v1/read/:key"
    }
  }

  examples {
    example object_round_trip {
      when {
        let k = put("obj", "hello")
      }
      then {
        read(k) == "hello"
      }
    }
  }
}
`;

const put = `export async function put(input, io) {
  await io.set(input.key, { text: input.text, n: 7 });
  await io.set(input.key + ':scalar', input.text);
  return { result: input.key };
}`;

const read = `export async function read(input, io) {
  const record = await io.get(input.key);
  const scalar = await io.get(input.key + ':scalar');
  const missing = await io.get('never-written');
  if (missing !== null) return { error: "Invalid" };
  if (record === null || record.text !== scalar) return { error: "NotFound" };
  // The envelope must not leak: what went in comes back, not { b, h }.
  if (record.b !== undefined || record.h !== undefined) return { error: "Invalid" };
  return { result: record.text };
}`;

test('io.set/io.get round-trip an object and a scalar; a missing key is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-getset-'));
  try {
    await writeFile(join(dir, 'put.mjs'), put, 'utf8');
    await writeFile(join(dir, 'read.mjs'), read, 'utf8');
    const mod = parse(spec, 'main.arc');
    const built = await buildExample(mod, dir, { implDir: dir });
    const report = await runExamples(mod, built.dir);
    assert.deepEqual(
      report.examples.map((item) => (item.ok ? 'ok' : item.example + ': ' + item.error)),
      ['ok'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save/load still speak the envelope io.get/io.set writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-getset2-'));
  const legacy = `export async function put(input, io) {
  await io.set(input.key, { text: input.text });
  const rec = await io.load(input.key);
  if (!rec || rec.b.text !== input.text) return { error: "Invalid" };
  await io.save(input.key + ':old', { b: { text: input.text + '-old' }, h: null });
  const old = await io.get(input.key + ':old');
  return { result: old.text };
}`;
  try {
    await writeFile(join(dir, 'put.mjs'), legacy, 'utf8');
    await writeFile(
      join(dir, 'read.mjs'),
      `export async function read(input, io) { return { result: input.key }; }`,
      'utf8',
    );
    const mod = parse(spec.replace('read(k) == "hello"', 'read(k) == "hello-old"'), 'main.arc');
    const built = await buildExample(mod, dir, { implDir: dir });
    const report = await runExamples(mod, built.dir);
    assert.deepEqual(
      report.examples.map((item) => (item.ok ? 'ok' : item.example + ': ' + item.error)),
      ['ok'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the scaffolded impl/README names the io surface and the record shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-new-'));
  try {
    const { scaffold } = await import('../src/new.ts');
    const made = await scaffold('demo', dir);
    const readme = await readFile(join(made.dir, 'impl', 'README.md'), 'utf8');
    for (const needle of ['io.get(key)', 'io.set(key, value)', 'msg:<key>', '{ b: <value>, h: <hash|null> }', 'io.load/io.save']) {
      assert.ok(readme.includes(needle), 'impl/README.md names ' + needle);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
