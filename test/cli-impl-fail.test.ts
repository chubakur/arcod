// 'arcod impl' prints 'impl: 0/1 bodies' with a fail line — and used to exit 0
// anyway, so 'arcod impl && arcod test' ran against a body file that does not
// even parse. The exit status is what scripts read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const SPEC = [
  'module demo @0.1.0 {}',
  '',
  'service Ping : http {',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '      post: result == "pong"',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

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
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(' ')); };
  try {
    await main(argv);
    return { out: out.join('\n'), err: err.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = before;
  }
}

test('impl exits 1 when the model writes a body that does not parse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-impl-fail-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'export async function ping(input, io) {', stream: false }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;

  let result: Result;
  try {
    result = await run(['impl', dir, '--endpoint', 'http://127.0.0.1:' + port, '--model', 'mock', '--no-cache']);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }

  assert.equal(result.code, 1, 'a failed body is a failed command: ' + result.out + result.err);
  assert.match(result.out, /impl: 0\/1 bodies/, 'the report counts the failure');
  assert.match(result.out, /fail T-\d+/, 'the failing task is marked');
  assert.match(result.out, /impl\/ping\.mjs:2/, 'and the error names the file and line');
});
