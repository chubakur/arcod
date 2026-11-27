// B95 narrowing, CLI slice: `arcod migrate` reads the bodies once and writes
// the same narrow schema the build embeds, so a DTO next to the facts is not a
// table in either artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SPEC = [
  'module analytics @0.1.0 {}',
  '',
  'type DeliveryEvent = { id: string, day: string, bytes: int, at: datetime }',
  'type DayRow = { day: string, total: int }',
  '',
  'service Analytics : http {',
  '  uses events: olap',
  '',
  '  effects {',
  '    allow events.append',
  '  }',
  '',
  '  contract {',
  '    public op record(id: string, day: string, bytes: int) -> { ok: bool } {',
  '      route: "POST /v1/record"',
  '      effects: events.append',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind events -> clickhouse',
  '  deploy docker',
  '}',
  '',
].join('\n');

const BODY = [
  'export async function record(input, io) {',
  '  await io.olapAppend("DeliveryEvent", { id: input.id, day: input.day, bytes: input.bytes, at: input.day });',
  '  return { result: { ok: true } };',
  '}',
].join('\n');

function run(dir: string): Promise<{ out: string; err: string; code: number }> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('CLICKHOUSE_') && key !== 'OLAP_URL') clean[key] = value;
  }
  return new Promise((done) => {
    const child = spawn(process.execPath, ['bin/arcod.mjs', 'migrate', dir, '--json'], { cwd: ROOT, env: clean });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('close', (code: number | null) => done({ out, err, code: code ?? 1 }));
  });
}

test('migrate writes only the table the body appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-narrow-cli-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'record.mjs'), BODY, 'utf8');
  const result = await run(dir);
  assert.equal(result.code, 0, result.err);
  const payload = JSON.parse(result.out);
  assert.deepEqual(payload.olap.tables, ['DeliveryEvent']);
  const sql = await readFile(join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DeliveryEvent"/);
  assert.doesNotMatch(sql, /"DayRow"/);
});

test('a body that names no table removes the stale schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-olap-narrow-stale-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  await mkdir(join(dir, 'impl'), { recursive: true });
  const schema = join(dir, '.arcod', 'build', 'clickhouse', 'schema.sql');
  await writeFile(join(dir, 'impl', 'record.mjs'), BODY, 'utf8');
  assert.equal((await run(dir)).code, 0);
  await readFile(schema, 'utf8');
  // The same project after the append moved out of the body: the schema an
  // earlier run wrote describes a table nothing writes to any more.
  await writeFile(join(dir, 'impl', 'record.mjs'), 'export async function record() {\n  return { result: { ok: true } };\n}\n', 'utf8');
  const result = await run(dir);
  assert.equal(result.code, 0, result.err);
  await assert.rejects(() => readFile(schema, 'utf8'), /ENOENT/);
});
