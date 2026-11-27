// The live half of B111: the generated Go service of examples/go-project1,
// compiled with the real toolchain and driven by `arcod test --url`. Until now
// every Go assertion was text: golden files and regexps cannot tell whether
// ServeMux panics at startup, whether a body's imports resolve, or whether the
// kv wire is spoken correctly. This test starts the binary against a fake RESP
// store on loopback and requires the same 5 checks the Node runtime answers.
//
// docker is not on this VM, so the store is a RESP server in-process: the
// service only needs GET/SET/DEL/EXISTS, which is exactly the kv facade.
// Skipped while no Go toolchain is on PATH (a plain checkout without Go).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { main } from '../src/cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
// A fixture, not an example: examples/ is the "every demo builds a Node
// service and runs its examples" promise, and a Go service answers neither.
const example = join(here, 'fixtures', 'go-project1');
const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

// A store that speaks just enough RESP for arcodio: inline arrays of bulk
// strings, GET/SET/DEL/EXISTS. SET's PX option is accepted and ignored; the
// live test does not sleep long enough to care about a ttl.
function fakeStore(): Promise<{ port: number; close: () => Promise<void> }> {
  const data = new Map<string, string>();
  const take = (buf: Buffer): { args: string[]; used: number } | null => {
    if (buf.length === 0 || buf[0] !== 42) return null;
    let pos = buf.indexOf('\r\n');
    if (pos < 0) return null;
    const count = Number(buf.subarray(1, pos).toString());
    pos += 2;
    const args: string[] = [];
    for (let i = 0; i < count; i += 1) {
      if (buf[pos] !== 36) return null;
      const end = buf.indexOf('\r\n', pos);
      if (end < 0) return null;
      const len = Number(buf.subarray(pos + 1, end).toString());
      const start = end + 2;
      if (buf.length < start + len + 2) return null;
      args.push(buf.subarray(start, start + len).toString());
      pos = start + len + 2;
    }
    return { args, used: pos };
  };
  const bulk = (value: string): string => '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n';
  const server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = take(buf);
        if (parsed === null) return;
        buf = buf.subarray(parsed.used);
        const [command, ...args] = parsed.args;
        const name = (command ?? '').toUpperCase();
        if (name === 'GET') {
          const value = data.get(args[0]!);
          socket.write(value === undefined ? '$-1\r\n' : bulk(value));
        } else if (name === 'SET') {
          data.set(args[0]!, args[1]!);
          socket.write('+OK\r\n');
        } else if (name === 'DEL') {
          socket.write(':' + (data.delete(args[0]!) ? 1 : 0) + '\r\n');
        } else if (name === 'EXISTS') {
          socket.write(':' + (data.has(args[0]!) ? 1 : 0) + '\r\n');
        } else if (name === 'PING') {
          socket.write('+PONG\r\n');
        } else {
          socket.write('-ERR unknown command ' + name + '\r\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url + '/healthz');
      if (response.ok) return;
    } catch {
      // The socket is not up yet; retry until the budget runs out.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the go service never answered /healthz at ' + url);
}

test(
  'the generated go service answers every project1 example through test --url',
  { skip: hasGo ? false : 'no go toolchain on PATH' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-golive-'));
    const store = await fakeStore();
    let service: ReturnType<typeof spawn> | null = null;
    try {
      const spec = await readFile(join(example, 'main.arc'), 'utf8');
      const mod = parse(spec, 'main.arc');
      await buildExample(mod, dir, { implDir: join(example, 'impl') });
      const serviceDir = join(dir, '.arcod', 'build', 'service');
      const binary = join(dir, 'service');
      const built = spawnSync('go', ['build', '-o', binary, '.'], {
        cwd: serviceDir,
        encoding: 'utf8',
        env: { ...process.env, GOFLAGS: '-mod=mod' },
      });
      assert.equal(built.status, 0, 'go build failed: ' + built.stderr);
      const port = await freePort();
      const url = 'http://127.0.0.1:' + port;
      service = spawn(binary, [], {
        env: { ...process.env, PORT: String(port), KV_HOST: '127.0.0.1', KV_PORT: String(store.port) },
        stdio: 'ignore',
      });
      await waitForHealth(url);
      const out: string[] = [];
      const realLog = console.log;
      console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
      try {
        await main(['test', example, '--url', url]);
      } finally {
        console.log = realLog;
      }
      const text = out.join('\n');
      // Every example and both rules: the count is the criterion, a silent
      // '4 passed' must fail this test rather than shrink the run.
      assert.match(text, /5 passed, 0 failed/, 'arcod test --url answered:\n' + text);
    } finally {
      service?.kill('SIGKILL');
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
