// The last piece of B111's criterion, live: a message published by a generated
// NODE service is consumed by a generated GO service on the same broker. The
// two processes share nothing but the wire — the Node runtime's envelope on
// 'arcod:q:<topic>' — so this is also the regression guard against the two
// emitters drifting apart.
//
// The broker is a RESP server in-process (docker is not on this VM). Skipped
// while no Go toolchain is on PATH.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

const header = [
  'module shop @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.queue @1',
  '',
  'type OrderId = uuid',
  'error Invalid',
  '',
  'service Api : http {',
  '  uses events: queue',
  '',
  '  contract {',
  '    public op publish(id: OrderId) -> { id: OrderId } {',
  '      route: "POST /v1/publish"',
  '      effects: events.publish',
  '      errors: Invalid',
  '      status: 201',
  '    }',
  '  }',
  '}',
  '',
  'service Worker : http {',
  '  language: go',
  '  uses store: kv',
  '  uses events: queue',
  '',
  '  contract {',
  '    job fulfil(id: OrderId) {',
  '      on: events.created',
  '      retry: 0',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind events -> redis(host: "q", port: 6379)',
  '  deploy docker',
  '}',
  '',
].join('\n');

// The build bundles a named export and strips the keyword. A Node body takes
// the parameter object as one argument — (input, io) — unlike a Go body, which
// takes the map — as in examples/orders/impl/create.mjs.
const publishBody = [
  'export async function publish(input, io) {',
  "  await io.queuePublish('created', { id: input.id });",
  '  return { id: input.id };',
  '}',
  '',
].join('\n');

const fulfilBody = [
  'func opFulfil(io *arcodio.IO, in map[string]any) (any, error) {',
  '\tid, _ := in["id"].(string)',
  '\treturn nil, io.KV.Set("fulfilled:"+id, "yes", 0)',
  '}',
  '',
].join('\n');

type FakeStore = { port: number; data: Map<string, string>; lists: Map<string, string[]>; zsets: Map<string, Map<string, number>>; close: () => Promise<void> };

function fakeStore(): Promise<FakeStore> {
  const data = new Map<string, string>();
  const lists = new Map<string, string[]>();
  // publishLater parks a message in a sorted set scored by its due moment
  // (B25); the consumer promotes what is due before each LPOP.
  const zsets = new Map<string, Map<string, number>>();
  const zset = (key: string): Map<string, number> => {
    const found = zsets.get(key);
    if (found) return found;
    const created = new Map<string, number>();
    zsets.set(key, created);
    return created;
  };
  const crlf = String.fromCharCode(13, 10);
  const list = (key: string): string[] => {
    const found = lists.get(key);
    if (found) return found;
    const created: string[] = [];
    lists.set(key, created);
    return created;
  };
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
        } else if (name === 'RPUSH') {
          const target = list(args[0]!);
          for (const value of args.slice(1)) target.push(value);
          socket.write(':' + target.length + '\r\n');
        } else if (name === 'LPUSH') {
          const target = list(args[0]!);
          for (const value of args.slice(1)) target.unshift(value);
          socket.write(':' + target.length + '\r\n');
        } else if (name === 'LPOP') {
          const target = lists.get(args[0]!);
          const value = target && target.length > 0 ? target.shift()! : undefined;
          socket.write(value === undefined ? '$-1\r\n' : bulk(value));
        } else if (name === 'ZADD') {
          const target = zset(args[0]!);
          const added = target.has(args[2]!) ? 0 : 1;
          target.set(args[2]!, Number(args[1]));
          socket.write(':' + added + crlf);
        } else if (name === 'ZRANGEBYSCORE') {
          const target = zset(args[0]!);
          const min = args[1] === '-inf' ? -Infinity : Number(args[1]);
          const max = args[2] === '+inf' ? Infinity : Number(args[2]);
          let members = [...target.entries()]
            .filter(([, score]) => score >= min && score <= max)
            .sort((a, b) => a[1] - b[1])
            .map(([member]) => member);
          if ((args[3] ?? '').toUpperCase() === 'LIMIT') {
            const offset = Number(args[4] ?? 0);
            const count = Number(args[5] ?? 0);
            members = members.slice(offset, count > 0 ? offset + count : undefined);
          }
          socket.write('*' + members.length + crlf + members.map(bulk).join(''));
        } else if (name === 'ZREM') {
          socket.write(':' + (zset(args[0]!).delete(args[1]!) ? 1 : 0) + crlf);
        } else if (name === 'LLEN') {
          socket.write(':' + (lists.get(args[0]!) ?? []).length + '\r\n');
        } else if (name === 'LRANGE') {
          const target = lists.get(args[0]!) ?? [];
          const start = Number(args[1]);
          const stop = Number(args[2]);
          const slice = target.slice(start, stop < 0 ? undefined : stop + 1);
          socket.write('*' + slice.length + '\r\n' + slice.map(bulk).join(''));
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
        data,
        lists,
        zsets,
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

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for ' + what);
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url + '/healthz');
    return response.ok;
  } catch {
    return false;
  }
}

test(
  'a node service publishes the message a go service consumes',
  { skip: hasGo ? false : 'no go toolchain on PATH' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-mixed-'));
    const store = await fakeStore();
    let api: ReturnType<typeof spawn> | null = null;
    let worker: ReturnType<typeof spawn> | null = null;
    try {
      // Per-service body folders are named after the service, case included:
      // scanImplFiles matches the declared name, not a slug.
      await mkdir(join(dir, 'impl', 'Api'), { recursive: true });
      await mkdir(join(dir, 'impl', 'Worker'), { recursive: true });
      await writeFile(join(dir, 'impl', 'Api', 'publish.mjs'), publishBody, 'utf8');
      await writeFile(join(dir, 'impl', 'Worker', 'fulfil.go'), fulfilBody, 'utf8');
      // No reference mode: both services take their bodies from impl/.
      await buildExample(parse(header, 'main.arc'), dir, {});

      const workerDir = join(dir, '.arcod', 'build', 'service-worker');
      const binary = join(dir, 'worker');
      const built = spawnSync('go', ['build', '-o', binary, '.'], {
        cwd: workerDir,
        encoding: 'utf8',
        env: { ...process.env, GOFLAGS: '-mod=mod' },
      });
      assert.equal(built.status, 0, 'go build failed: ' + built.stderr);

      const workerPort = await freePort();
      const workerLog: string[] = [];
      worker = spawn(binary, [], {
        env: {
          ...process.env,
          PORT: String(workerPort),
          KV_HOST: '127.0.0.1',
          KV_PORT: String(store.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stderr?.on('data', (chunk: Buffer) => workerLog.push(chunk.toString()));
      worker.stdout?.on('data', (chunk: Buffer) => workerLog.push(chunk.toString()));
      await waitFor('the go worker to answer /healthz', () => health('http://127.0.0.1:' + workerPort));

      const apiPort = await freePort();
      const apiErrors: string[] = [];
      api = spawn(process.execPath, [join(dir, '.arcod', 'build', 'service', 'index.mjs')], {
        env: {
          ...process.env,
          PORT: String(apiPort),
          QUEUE_REDIS_URL: 'redis://127.0.0.1:' + store.port,
          SQL_DRIVER: 'memory',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      api.stderr?.on('data', (chunk: Buffer) => apiErrors.push(chunk.toString()));
      api.stdout?.on('data', (chunk: Buffer) => apiErrors.push(chunk.toString()));
      const apiBase = 'http://127.0.0.1:' + apiPort;
      // The api declares no store, so its /healthz answers 503 by design: the
      // probe pings a store this service does not have. Wait for the http
      // server itself instead — a route miss is the 404 that proves it listens.
      try {
        await waitFor('the node api to answer', async () => {
          try {
            const probe = await fetch(apiBase + '/nope');
            return probe.status === 404;
          } catch {
            return false;
          }
        });
      } catch (error) {
        throw new Error(String(error) + '\nnode api said: ' + apiErrors.join(''));
      }

      const response = await fetch(apiBase + '/v1/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'n1' }),
      });
      assert.equal(response.status, 201, 'the node op answered ' + response.status);

      // The Node runtime wrote the envelope; the Go consumer must drain it and
      // run the body, whose only observable effect is the kv write.
      try {
        await waitFor('the go worker to write fulfilled:n1', async () => store.data.get('fulfilled:n1') === 'yes');
      } catch (error) {
        const lists = [...store.lists.entries()].map(([key, values]) => key + '=' + JSON.stringify(values)).join(' ');
        throw new Error(
          String(error) + '\nlists: ' + lists + '\ndata: ' + JSON.stringify([...store.data.keys()]) +
          '\nworker said: ' + workerLog.join(''),
        );
      }
      assert.equal((store.lists.get('arcod:q:created') ?? []).length, 0, 'the topic is drained');
    } finally {
      api?.kill('SIGKILL');
      worker?.kill('SIGKILL');
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
