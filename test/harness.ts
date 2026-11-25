// Shared integration harness for the test matrix: build a spec into a temp
// directory, start the generated service on a free port (memory drivers), and
// hand back a base URL plus a tiny mock HTTP server for external services.
//
// Not a test file itself — imported by authz/contract/soak/property suites.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExample } from '../src/build.ts';
import type { ProviderRegistry } from '../src/registry.ts';
import { parse } from '../src/parser.ts';

export interface ServiceInstance {
  base: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

export interface StartOptions {
  impl?: Record<string, string>;
  // impl/lib.mjs: shared helpers the bodies call as top-level names.
  implLib?: string;
  env?: Record<string, string>;
  reference?: boolean;
  // Plugin providers reach the build the same way check sees them.
  registry?: ProviderRegistry;
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
  const built = await buildExample(mod, dir, {
    implDir,
    // An explicit lib wins; with body files written here there is no
    // impl/lib.mjs to find on disk.
    implLib: options.implLib ?? null,
    reference: options.reference,
    registry: options.registry,
  });

  // A hardcoded port range races other test files: a losing child dies on
  // EADDRINUSE while the winner answers /healthz, and the suite then drives the
  // wrong service (seen as a sudden 404 in an unrelated test). Ask the OS for a
  // free port, and retry if our child loses it anyway.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [join(built.dir, 'service', 'index.mjs')], {
      env: { ...process.env, ...MEMORY_DRIVERS, PORT: String(port), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    const base = 'http://127.0.0.1:' + port;
    try {
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
    } catch (error) {
      child.kill('SIGKILL');
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  await rm(dir, { recursive: true, force: true });
  throw lastError ?? new Error('service did not start');
}

// Bind port 0, read what the kernel handed out, release it. The window between
// close and the child's listen is tiny and the retry above covers it.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base: string, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 8000;
  // Two consecutive healthy answers with a live child: a single one can come
  // from a foreign process that already owns the port.
  let healthy = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('service exited before start: ' + stderr.join('').slice(-2000));
    }
    if (stderr.join('').includes('EADDRINUSE')) {
      throw new Error('port already in use: ' + stderr.join('').slice(-500));
    }
    try {
      const response = await fetch(base + '/healthz');
      healthy = response.ok ? healthy + 1 : 0;
      if (healthy >= 2) return;
    } catch {
      healthy = 0; // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
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
