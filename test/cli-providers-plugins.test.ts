// `arcod providers --plugins` is the operator's view of an installed manifest:
// what package, which API it speaks, what it declares. The JSON form was
// covered; the text form — the one a human reads before trusting a package —
// was not, nor was the "nothing installed" line or a manifest of a future API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

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
  console.log = (...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

async function project(manifest: unknown | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-providers-'));
  await mkdir(join(dir, '.arcod', 'plugins', 'nats'), { recursive: true });
  if (manifest !== null) {
    await writeFile(join(dir, '.arcod', 'plugins', 'nats', 'arcod.plugin.json'), JSON.stringify(manifest), 'utf8');
  }
  return dir;
}

const manifest = (pluginApi = 1) => ({
  name: 'arcod-plugin-nats',
  version: '0.1.0',
  arcod: {
    pluginApi,
    capabilities: [{ name: 'queue', summary: 'pub/sub' }],
    providers: [{ name: 'nats', capability: 'queue' }],
  },
});

test('providers --plugins names the package, its API, its capability and its provider', async () => {
  const dir = await project(manifest());
  const before = process.cwd();
  const savedPath = process.env.ARC_PLUGIN_PATH;
  try {
    delete process.env.ARC_PLUGIN_PATH;
    process.chdir(dir);
    const result = await run(['providers', '--plugins']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^arcod-plugin-nats@0\.1\.0 {2}api 1 {2}/m);
    assert.match(result.out, /^ {2}capability queue — pub\/sub$/m);
    assert.match(result.out, /^ {2}provider {3}nats -> queue$/m);
  } finally {
    process.chdir(before);
    if (savedPath === undefined) delete process.env.ARC_PLUGIN_PATH;
    else process.env.ARC_PLUGIN_PATH = savedPath;
  }
});

test('providers --plugins says so when no manifest is installed', async () => {
  const dir = await project(null);
  const before = process.cwd();
  const savedPath = process.env.ARC_PLUGIN_PATH;
  try {
    delete process.env.ARC_PLUGIN_PATH;
    process.chdir(dir);
    const result = await run(['providers', '--plugins']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /no plugins found: ARC_PLUGIN_PATH, \.\/\.arcod\/plugins, ~\/\.arcod\/plugins are empty/);
  } finally {
    process.chdir(before);
    if (savedPath === undefined) delete process.env.ARC_PLUGIN_PATH;
    else process.env.ARC_PLUGIN_PATH = savedPath;
  }
});

test('providers --plugins prints an unsupported API as a warning, not a plugin', async () => {
  const dir = await project(manifest(99));
  const before = process.cwd();
  const savedPath = process.env.ARC_PLUGIN_PATH;
  try {
    delete process.env.ARC_PLUGIN_PATH;
    process.chdir(dir);
    const result = await run(['providers', '--plugins']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /pluginApi 99 is not supported/);
    assert.equal(result.out.includes('arcod-plugin-nats@'), false, 'an ignored plugin is not listed');
    assert.match(result.out, /no plugins found/);
  } finally {
    process.chdir(before);
    if (savedPath === undefined) delete process.env.ARC_PLUGIN_PATH;
    else process.env.ARC_PLUGIN_PATH = savedPath;
  }
});
