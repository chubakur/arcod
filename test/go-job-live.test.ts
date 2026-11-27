// The consumer half of the queue (B111.2), live: a message written in the Node
// runtime's envelope on 'arcod:q:<topic>' is drained by the generated Go
// service, the job body runs, and the work is visible in the kv store. A body
// that fails is retried and, out of retries, written to '<topic>:dead' — the
// same three places the Node runtime uses, so one broker serves both.
//
// The store is a RESP server in-process (docker is not on this VM): the service
// needs kv commands plus LPOP/LPUSH/RPUSH for the consumer. Skipped while no Go
// toolchain is on PATH.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

const spec = `module orders @0.1.0 {}

use capability arcod.std.kv @1
use capability arcod.std.queue @1

type OrderId = uuid
type Sku = bytes(min: 1, max: 64)
error Invalid

service Orders : http {
  language: go
  uses store: kv
  uses events: queue

  contract {
    public op place(id: OrderId, sku: Sku) -> { id: OrderId, sku: Sku } {
      route: "POST /v1/orders"
      errors: Invalid
      status: 201
    }

    // retry: 1 gives the failing message exactly one retry, so the test also
    // walks the requeue path and the first (250ms) backoff, not just the
    // dead-letter write.
    job fulfil(id: OrderId) {
      on: events.orders
      retry: 1
    }
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind events -> redis(host: "q", port: 6379)
  deploy docker
}
`;

const placeBody = `func opPlace(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	return map[string]any{"id": id}, nil
}
`;

// The job body is a plain function of the message: it reads the parameter the
// consumer filled and answers Invalid for the one id the test uses to fail.
const fulfilBody = `func opFulfil(io *arcodio.IO, in map[string]any) (any, error) {
	id, _ := in["id"].(string)
	if id == "bad" {
		return nil, ErrInvalid
	}
	if err := io.KV.Set("fulfilled:"+id, "yes", 0); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "status": "fulfilled"}, nil
}
`;

type FakeStore = {
  port: number;
  data: Map<string, string>;
  lists: Map<string, string[]>;
  close: () => Promise<void>;
};

// RESP, just enough for arcodio: inline arrays of bulk strings, the kv verbs,
// and the four list verbs the consumer loop uses.
function fakeStore(): Promise<FakeStore> {
  const data = new Map<string, string>();
  const lists = new Map<string, string[]>();
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
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// One RESP round trip from the test process: this is how the Node runtime
// writes a message, so the wire under test is the shared one.
function respCommand(port: number, args: string[]): Promise<string | number | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = '';
    socket.setEncoding('utf8');
    const parts = ['*' + args.length + '\r\n'];
    for (const arg of args) parts.push('$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n');
    socket.on('connect', () => socket.write(parts.join('')));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const line = buf.split('\r\n')[0] ?? '';
      if (line.length === 0) return;
      const kind = line[0];
      if (kind === '+') {
        socket.end();
        resolve(line.slice(1));
      } else if (kind === ':') {
        socket.end();
        resolve(Number(line.slice(1)));
      } else if (kind === '$') {
        const size = Number(line.slice(1));
        if (size < 0) {
          socket.end();
          resolve(null);
          return;
        }
        const start = buf.indexOf('\r\n') + 2;
        socket.end();
        resolve(buf.slice(start, start + size));
      } else {
        socket.end();
        reject(new Error('RESP error: ' + line));
      }
    });
    socket.on('error', reject);
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  'a node-envelope message is consumed by the go job, and a failing one is dead-lettered',
  { skip: hasGo ? false : 'no go toolchain on PATH' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-gojob-'));
    const store = await fakeStore();
    let service: ReturnType<typeof spawn> | null = null;
    try {
      await mkdir(join(dir, 'impl'), { recursive: true });
      await writeFile(join(dir, 'impl', 'place.go'), placeBody, 'utf8');
      await writeFile(join(dir, 'impl', 'fulfil.go'), fulfilBody, 'utf8');
      await buildExample(parse(spec, 'main.arc'), dir, { reference: true });
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
      await waitFor('the service to answer /healthz', () => health(url));

      // What a Node publisher writes: RPUSH on the topic with {payload, attempts}.
      await respCommand(store.port, [
        'RPUSH',
        'arcod:q:orders',
        JSON.stringify({ payload: { id: 'a1' }, attempts: 0 }),
      ]);
      await waitFor('the job to write fulfilled:a1', async () => store.data.get('fulfilled:a1') === 'yes');
      assert.equal((store.lists.get('arcod:q:orders') ?? []).length, 0, 'the consumed message was acked');

      // The same wire, a body that answers a declared error: the message leaves
      // the topic and lands in the dead letter with its attempt counted.
      await respCommand(store.port, [
        'RPUSH',
        'arcod:q:orders',
        JSON.stringify({ payload: { id: 'bad' }, attempts: 0 }),
      ]);
      await waitFor('the failed message to reach the dead letter', async () => (store.lists.get('arcod:q:orders:dead') ?? []).length > 0);
      const dead = store.lists.get('arcod:q:orders:dead') ?? [];
      assert.equal(dead.length, 1, 'exactly one dead letter: ' + JSON.stringify(dead));
      const entry = JSON.parse(dead[0]!) as { payload?: { id?: string }; attempts?: number; lastError?: string };
      assert.equal(entry.payload?.id, 'bad');
      // One retry means two attempts: the message was requeued once with the
      // attempt count carried in the envelope, as the Node runtime does.
      assert.equal(entry.attempts, 2);
      assert.ok((entry.lastError ?? '').length > 0, 'the dead letter names the failure: ' + dead[0]);
      assert.equal((store.lists.get('arcod:q:orders') ?? []).length, 0, 'the failed message left the topic');

      // A message that is not the envelope at all must not stop the loop: it is
      // dead-lettered as unreadable, with a fixed phrase and no payload echo.
      await respCommand(store.port, ['RPUSH', 'arcod:q:orders', 'not json']);
      await waitFor('the unreadable message to reach the dead letter', async () => (store.lists.get('arcod:q:orders:dead') ?? []).length === 2);
      const unreadable = JSON.parse((store.lists.get('arcod:q:orders:dead') ?? [])[1]!) as {
        payload?: unknown;
        attempts?: number;
        lastError?: string;
      };
      assert.equal(unreadable.payload, null);
      assert.equal(unreadable.attempts, 0);
      assert.equal(unreadable.lastError, 'unreadable message');
      // The loop is still alive after a malformed message.
      await respCommand(store.port, [
        'RPUSH',
        'arcod:q:orders',
        JSON.stringify({ payload: { id: 'a2' }, attempts: 0 }),
      ]);
      await waitFor('the job to keep consuming after an unreadable message', async () => store.data.get('fulfilled:a2') === 'yes');
    } finally {
      service?.kill('SIGKILL');
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
