import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './harness.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildExample } from '../src/build.ts';

// A counter must not walk pages: io.count(entity, { where }) asks the driver for
// a total, so 1200 records stay 1200 even when find is called with limit 10.
// Both drivers answer the same on the same data.

const KV_SPEC = "module stats @0.1.0 {}\n\nuse capability arcod.std.kv @1\n\ntype Hit = { id: string, kind: string, score: int }\ntype Seeded = { n: int }\ntype Counts = { total: int, page: int, hot: int }\n\nservice Stats : http {\n  uses store: kv(ttl: 1h)\n\n  effects {\n    allow store.insert, store.find, store.count\n  }\n\n  contract {\n    public op seed(n: int) -> Seeded {\n      route: \"POST /v1/seed\"\n      effects: store.insert\n    }\n\n    public op report() -> Counts {\n      route: \"GET /v1/report\"\n      effects: store.find, store.count\n    }\n  }\n}\n\nenvironment dev {\n  bind store -> redis(host: \"kv\", port: 6379)\n  deploy docker\n}\n";

const SQL_SPEC = KV_SPEC
  .replace('use capability arcod.std.kv @1', 'use capability arcod.std.sql @1')
  .replace('uses store: kv(ttl: 1h)', 'uses store: sql')
  .replace('bind store -> redis(host: "kv", port: 6379)', 'bind store -> mysql');

const SEED = "export async function seed(input, io) {\n  for (let i = 0; i < Number(input.n); i += 1) {\n    await io.insert('Hit', { id: 'h' + i, kind: i % 2 === 0 ? 'a' : 'b', score: i });\n  }\n  return { result: { n: Number(input.n) } };\n}\n";

const REPORT_BODY = "export async function report(input, io) {\n  const page = await io.find('Hit', { limit: 10 });\n  const total = await io.count('Hit');\n  const hot = await io.count('Hit', { where: { kind: 'a' }, limit: 1 });\n  return { result: { total, page: page.items.length, hot } };\n}\n";

const impl = { seed: SEED, report: REPORT_BODY };

test('kv: count is a total independent of the find page size', async () => {
  assert.deepEqual(check(parse(KV_SPEC, 'main.arc')).filter((d) => d.severity === 'error'), []);
  const svc = await startService(KV_SPEC, { impl });
  try {
    const seeded = await fetch(svc.base + '/v1/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1200 }),
    });
    assert.ok(seeded.status === 200 || seeded.status === 201, 'seed succeeded');
    assert.deepEqual(await seeded.json(), { n: 1200 });
    const res = await fetch(svc.base + '/v1/report');
    assert.equal(res.status, 200);
    const counts = await res.json();
    assert.equal(counts.total, 1200, 'count does not stop at the find page');
    assert.equal(counts.page, 10, 'find keeps its limit');
    assert.equal(counts.hot, 600, 'where filters the count the same way find does');
  } finally {
    await svc.stop();
  }
});

test('sql: the generated store counts with COUNT(*) and never with a page', async () => {
  assert.deepEqual(check(parse(SQL_SPEC, 'main.arc')).filter((d) => d.severity === 'error'), []);
  const root = await mkdtemp(join(tmpdir(), 'arcod-count-'));
  try {
    await writeFile(join(root, 'main.arc'), SQL_SPEC);
    const implDir = join(root, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'seed.mjs'), SEED);
    await writeFile(join(implDir, 'report.mjs'), REPORT_BODY);
    const result = await buildExample(parse(SQL_SPEC, 'main.arc'), root, { port: 8080, implDir });
    const code = await readFile(join(result.dir, 'service', 'index.mjs'), 'utf8');
    const at = code.indexOf('SELECT COUNT(*) AS n FROM');
    assert.ok(at > 0, 'the sql store counts in the database');
    const countBlock = code.slice(code.lastIndexOf('async entityCount', at), at + 200);
    assert.match(countBlock, /async entityCount/);
    assert.doesNotMatch(countBlock, /LIMIT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sql driver in memory: count matches find over the same rows', async () => {
  const svc = await startService(SQL_SPEC, { impl });
  try {
    await fetch(svc.base + '/v1/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 40 }),
    });
    const res = await fetch(svc.base + '/v1/report');
    assert.equal(res.status, 200, 'report answered: ' + (await res.clone().text()));
    const counts = await res.json();
    assert.equal(counts.total, 40);
    assert.equal(counts.page, 10);
    assert.equal(counts.hot, 20);
  } finally {
    await svc.stop();
  }
});
