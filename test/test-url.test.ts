import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { main } from '../src/cli.ts';

// `arcod test --url` turns the contract into an executable spec for a service
// that is already running: no build, no spawn, no .arcod/build. A Go or
// hand-written service is then held to the same examples as a generated one.
const specPath = 'examples/project1/main.arc';

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const before = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startService(buildRoot: string): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(buildRoot, '.arcod', 'build', 'service', 'index.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      KV_DRIVER: 'memory',
      SQL_DRIVER: 'memory',
      AUTH_DRIVER: 'memory',
      BLOB_DRIVER: 'memory',
      LLM_DRIVER: 'memory',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const url = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url + '/healthz');
      if (response.ok) return { url, stop: () => child.kill('SIGTERM') };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('service did not answer /healthz');
}

test('test --url: an already running service passes the examples and leaves no build', async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), 'arcod-url-build-'));
  const specDir = await mkdtemp(join(tmpdir(), 'arcod-url-spec-'));
  try {
    const text = await readFile(specPath, 'utf8');
    await cp('examples/project1/impl', join(buildRoot, 'impl'), { recursive: true });
    await buildExample(parse(text, 'main.arc'), buildRoot, { port: 0 });
    const service = await startService(buildRoot);
    try {
      await writeFile(join(specDir, 'main.arc'), text, 'utf8');
      const report = await run(['test', specDir, '--url', service.url]);
      assert.equal(report.code, 0, report.out + '\n' + report.err);
      assert.match(report.out, /5 passed, 0 failed/);
      assert.equal(existsSync(join(specDir, '.arcod', 'build')), false);

      const json = await run(['test', specDir, '--url', service.url, '--json']);
      assert.equal(json.code, 0);
      const parsed = JSON.parse(json.out);
      assert.equal(parsed.target, 'url');
      assert.equal(parsed.url, service.url);
      assert.equal(parsed.examples.length, 3);
    } finally {
      service.stop();
    }
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
    await rm(specDir, { recursive: true, force: true });
  }
});

test('test --url: an unreachable address is exit 2 with the address', async () => {
  const specDir = await mkdtemp(join(tmpdir(), 'arcod-url-'));
  try {
    await writeFile(join(specDir, 'main.arc'), await readFile(specPath, 'utf8'), 'utf8');
    const result = await run(['test', specDir, '--url', 'http://127.0.0.1:1']);
    assert.equal(result.code, 2);
    assert.match(result.err, /cannot reach http:\/\/127\.0\.0\.1:1/);
    assert.equal(existsSync(join(specDir, '.arcod', 'build')), false);
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
});

test('test --url: --reference is a usage error that names both flags', async () => {
  const specDir = await mkdtemp(join(tmpdir(), 'arcod-url-'));
  try {
    await writeFile(join(specDir, 'main.arc'), await readFile(specPath, 'utf8'), 'utf8');
    const result = await run(['test', specDir, '--url', 'http://127.0.0.1:1', '--reference']);
    assert.equal(result.code, 2);
    assert.match(result.err, /--url/);
    assert.match(result.err, /--impl or --reference/);
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
});
