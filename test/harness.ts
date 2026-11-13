// Shared integration harness for the test matrix: build a spec into a temp
// directory, start the generated service on a free port (memory drivers), and
// hand back a base URL plus a tiny mock HTTP server for external services.
//
// Not a test file itself — imported by authz/contract/soak/property suites.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';

export interface ServiceInstance {
  base: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

export interface StartOptions {
  impl?: Record<string, string>;
  env?: Record<string, string>;
  reference?: boolean;
}

const MEMORY_DRIVERS = {
  KV_DRIVER: 'memory',
  SQL_DRIVER: 'memory',
  AUTH_DRIVER: 'memory',
  BLOB_DRIVER: 'memory',
};

export async function startService(source: string, options: StartOptions = {}): Promise<ServiceInstance> {
  const mod = parse(source, 'main.arc');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-harness-'));
  let implDir: string | null = null;
  if (options.impl) {
    const implRoot = join(dir, 'impl');
    await mkdir(implRoot, { recursive: true });
    for (const [op, body] of Object.entries(options.impl)) {
      await writeFile(join(implRoot, op + '.mjs'), body);
    }
    implDir = implRoot;
  }
  const built = await buildExample(mod, dir, { implDir, reference: options.reference });
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [join(built.dir, 'service', 'index.mjs')], {
    env: { ...process.env, ...MEMORY_DRIVERS, PORT: String(port), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const base = 'http://127.0.0.1:' + port;
  await waitForHealth(base, child, stderr);
  return {
    base,
    child,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(base: string, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('service exited before start: ' + stderr.join('').slice(-2000));
    }
    try {
      const response = await fetch(base + '/healthz');
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('service did not become healthy in 8s: ' + stderr.join('').slice(-2000));
}

// The memory auth driver reads the actor from these headers.
export function as(id: string, admin = false): Record<string, string> {
  return { 'x-actor': id, 'x-actor-name': id, 'x-admin': String(admin) };
}

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockServer {
  base: string;
  requests: MockRequest[];
  stop: () => Promise<void>;
}

// A dependency-free mock HTTP server for an external service. handler returns
// [status, jsonBody]; every request is captured for contract assertions.
export function mockHttp(
  handler: (req: MockRequest) => { status: number; body: unknown },
): Promise<MockServer> {
  const requests: MockRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
        const reply = handler(requests[requests.length - 1]);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        base: 'http://127.0.0.1:' + port,
        requests,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
