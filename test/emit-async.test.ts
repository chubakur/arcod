import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse, ParseError } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { buildPlan } from '../src/plan.ts';
import { emitService, pickService, routeOf, statusForError } from '../src/emit/service.ts';
import { checksumOf, migrationPlan } from '../src/migrate.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { emitWeb } from '../src/emit/web.ts';
import { composeYaml, nginxConf } from '../src/emit/compose.ts';
import { buildExample } from '../src/build.ts';
import { deployManifest } from '../src/deploy.ts';
import { providersForCapability } from '../src/providers.ts';
import { runExamples } from '../src/test.ts';
import { runPipeline } from '../src/pipeline.ts';
import { buildPrompts } from '../src/prompts.ts';
import { planBody } from '../src/plan-body.ts';
import { extractCode, validateBody, sandboxViolation } from '../src/impl.ts';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specUrl = new URL('../examples/onetimemessage/main.arc', import.meta.url);
const source = await readFile(specUrl, 'utf8');
const ast = parse(source, 'main.arc');

const mysqlUrl = new URL('../examples/project1-mysql/main.arc', import.meta.url);
const mysqlAst = parse(await readFile(mysqlUrl, 'utf8'), 'main.arc');

const filesUrl = new URL('../examples/files/main.arc', import.meta.url);
const filesAst = parse(await readFile(filesUrl, 'utf8'), 'main.arc');

// --- Async layer (M0.3): redis-backed stream + queue effects ---

// A broker just enough for the generated clients: pub/sub (SUBSCRIBE,
// UNSUBSCRIBE, PUBLISH) and lists (RPUSH/LPUSH/LPOP/LLEN/LRANGE). Lets the
// e2e tests prove the wire protocol without docker.
async function startFakeRedis(port: number): Promise<() => Promise<void>> {
  const { createServer } = await import('node:net');
  const subs = new Map<string, Set<import('node:net').Socket>>();
  const lists = new Map<string, string[]>();
  const bulk = (value: string) => '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n';
  const array = (items: string[]) => '*' + items.length + '\r\n' + items.join('');

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer]);
      for (;;) {
        if (buffer.length < 1 || buffer[0] !== 0x2a) break;
        const headEnd = buffer.indexOf('\r\n');
        if (headEnd === -1) break;
        const count = Number(buffer.toString('utf8', 1, headEnd));
        let offset = headEnd + 2;
        const args: string[] = [];
        let complete = true;
        for (let i = 0; i < count; i += 1) {
          if (offset >= buffer.length || buffer[offset] !== 0x24) { complete = false; break; }
          const lenEnd = buffer.indexOf('\r\n', offset);
          if (lenEnd === -1) { complete = false; break; }
          const len = Number(buffer.toString('utf8', offset + 1, lenEnd));
          const start = lenEnd + 2;
          if (buffer.length < start + len + 2) { complete = false; break; }
          args.push(buffer.toString('utf8', start, start + len));
          offset = start + len + 2;
        }
        if (!complete) break;
        buffer = buffer.subarray(offset);

        const cmd = args[0].toUpperCase();
        if (cmd === 'PING') socket.write('+PONG\r\n');
        else if (cmd === 'SUBSCRIBE') {
          const channel = args[1];
          const set = subs.get(channel) || new Set();
          set.add(socket);
          subs.set(channel, set);
          socket.write(array([bulk('subscribe'), bulk(channel), ':1\r\n']));
        } else if (cmd === 'UNSUBSCRIBE') {
          const set = subs.get(args[1]);
          if (set) { set.delete(socket); if (set.size === 0) subs.delete(args[1]); }
          socket.write(array([bulk('unsubscribe'), bulk(args[1]), ':0\r\n']));
        } else if (cmd === 'PUBLISH') {
          const set = subs.get(args[1]);
          let delivered = 0;
          if (set) {
            const frame = array([bulk('message'), bulk(args[1]), bulk(args[2])]);
            for (const client of set) { client.write(frame); delivered += 1; }
          }
          socket.write(':' + delivered + '\r\n');
        } else if (cmd === 'RPUSH' || cmd === 'LPUSH') {
          const list = lists.get(args[1]) || [];
          if (cmd === 'RPUSH') list.push(args[2]);
          else list.unshift(args[2]);
          lists.set(args[1], list);
          socket.write(':' + list.length + '\r\n');
        } else if (cmd === 'LPOP') {
          const list = lists.get(args[1]) || [];
          const value = list.length > 0 ? list.shift()! : null;
          lists.set(args[1], list);
          socket.write(value == null ? '$-1\r\n' : bulk(value));
        } else if (cmd === 'LLEN') {
          socket.write(':' + (lists.get(args[1]) || []).length + '\r\n');
        } else if (cmd === 'LRANGE') {
          const list = lists.get(args[1]) || [];
          socket.write(array(list.map(bulk)));
        } else {
          socket.write('-ERR unknown command ' + cmd + '\r\n');
        }
      }
    });
    socket.on('close', () => {
      for (const [channel, set] of subs) { set.delete(socket); if (set.size === 0) subs.delete(channel); }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return async () => {
    for (const set of subs) for (const client of set[1]) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

const QUEUE_SPEC = `module pipetest @0.1.0 {
}

use capability arcod.std.kv @1
use capability arcod.std.ids @1
use capability arcod.std.queue @1

error Invalid

service Pipe : http {
  uses store: kv
  uses uuid: ids
  uses events: queue

  contract {
    public op submit(entry: string) -> bool {
      route: "POST /v1/submit"
      effects: events.publish
      errors: none
    }

    public op seen() -> list<string> {
      route: "GET /v1/seen"
      effects: store.scan
      errors: none
    }

    public op dead(topic: string) -> list<json> {
      route: "GET /v1/dead"
      effects: events.dead
      errors: none
    }

    job audit(entry: string) {
      on: events.jobs
      retry: 1
      effects: store.set
      errors: none
    }
  }

  effects {
    allow store.set, store.scan, events.publish, events.dead, uuid.new
    deny net, fs, exec
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind uuid -> local
  bind events -> redis(host: "events", port: 6379)
  deploy docker
}
`;

test('queue: on/retry clauses parse into the AST', () => {
  const mod = parse(QUEUE_SPEC, 'main.arc');
  const audit = mod.services[0].contract.find((op) => op.name === 'audit')!;
  assert.equal(audit.kind, 'job');
  const consume = audit.clauses.find((clause) => clause.kind === 'consume');
  assert.ok(consume && consume.kind === 'consume' && consume.source === 'events.jobs');
  const retry = audit.clauses.find((clause) => clause.kind === 'retry');
  assert.ok(retry && retry.kind === 'retry' && retry.value === 1);
});

test('queue: consumer wiring is checked (A051-A053, W017)', () => {
  const codes = (text: string) => check(parse(text, 'main.arc')).map((item) => item.code);

  // a consumer job is executed, so the not-executable warning is gone
  assert.ok(!codes(QUEUE_SPEC).includes('W017'));
  const scheduled = QUEUE_SPEC.replace('      on: events.jobs\n', '');
  assert.ok(codes(scheduled).includes('W017'), 'a job without a consumer is still not executed');

  const asOp = QUEUE_SPEC.replace('    job audit(entry: string) {', '    op audit(entry: string) {');
  assert.ok(codes(asOp).includes('A051'), 'only a job can consume');

  const unknownAlias = QUEUE_SPEC.replace('on: events.jobs', 'on: ghost.jobs');
  assert.ok(codes(unknownAlias).includes('A052'), 'unknown queue alias');

  const retryWithoutOn = QUEUE_SPEC.replace('      on: events.jobs\n', '');
  assert.ok(codes(retryWithoutOn).includes('A053'), 'retry without a consumer');
});

async function buildQueueService(dir: string, auditBody: string) {
  const implDir = join(dir, 'impl');
  await mkdir(implDir, { recursive: true });
  await writeFile(join(implDir, 'submit.mjs'), 'export async function submit(input, io) { return { result: await io.queuePublish("jobs", input.entry) }; }\n');
  await writeFile(join(implDir, 'seen.mjs'), 'export async function seen(input, io) { const items = await io.scan(); return { result: items.map((item) => item.b && item.b.entry).filter((entry) => entry != null) }; }\n');
  await writeFile(join(implDir, 'dead.mjs'), 'export async function dead(input, io) { return { result: await io.queueDead(input.topic) }; }\n');
  await writeFile(join(implDir, 'audit.mjs'), auditBody);
  const mod = parse(QUEUE_SPEC, 'main.arc');
  return buildExample(mod, dir, { implDir });
}

async function spawnService(builtDir: string, port: number, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [join(builtDir, 'service', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), KV_DRIVER: 'memory', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(base + '/healthz');
      if (res.ok) return { child, base };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('service did not start on ' + port);
}

async function waitFor<T>(probe: () => Promise<T | null>, attempts = 50): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value != null && (!Array.isArray(value) || value.length > 0)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition was not met in time');
}

test('queue: memory driver consumes, and a failing body retries then dead-letters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-queue-mem-'));
  const built = await buildQueueService(dir, [
    'export async function audit(input, io) {',
    '  const id = await io.new();',
    '  await io.save(id, { b: { entry: input.entry }, h: null });',
    '  return { result: true };',
    '}',
    '',
  ].join('\n'));
  const port = 19000 + Math.floor(Math.random() * 500);
  const { child, base } = await spawnService(built.dir, port, {});
  try {
    const ok = await fetch(base + '/v1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'hello-queue' }),
    });
    assert.equal(ok.status, 201);

    const seen = await waitFor(async () => {
      const res = await fetch(base + '/v1/seen');
      const body = await res.json() as string[];
      return Array.isArray(body) && body.includes('hello-queue') ? body : null;
    });
    assert.deepEqual(seen, ['hello-queue'], 'the consumer body saw the message');
  } finally {
    child.kill('SIGTERM');
  }

  // failing body: retried once (retry: 1), then moved to the dead letter
  const dir2 = await mkdtemp(join(tmpdir(), 'arcod-queue-dead-'));
  const built2 = await buildQueueService(dir2, 'export async function audit(input, io) { return { error: "Invalid" }; }\n');
  const port2 = 19500 + Math.floor(Math.random() * 500);
  const second = await spawnService(built2.dir, port2, {});
  try {
    await fetch(second.base + '/v1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'poison' }),
    });
    const dead = await waitFor(async () => {
      const res = await fetch(second.base + '/v1/dead?topic=jobs');
      const body = await res.json() as Array<{ payload: string; attempts: number; lastError: string }>;
      return Array.isArray(body) && body.length > 0 ? body : null;
    });
    assert.equal(dead[0].payload, 'poison');
    assert.equal(dead[0].attempts, 2, 'one initial delivery plus one retry');
    assert.ok(dead[0].lastError.includes('Invalid'));
  } finally {
    second.child.kill('SIGTERM');
  }
});

test('queue: the redis driver carries messages over the wire', async () => {
  const redisPort = 20000 + Math.floor(Math.random() * 5000);
  const stopRedis = await startFakeRedis(redisPort);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-queue-redis-'));
    const built = await buildQueueService(dir, [
      'export async function audit(input, io) {',
      '  const id = await io.new();',
      '  await io.save(id, { b: { entry: input.entry }, h: null });',
      '  return { result: true };',
      '}',
      '',
    ].join('\n'));
    const port = 19000 + Math.floor(Math.random() * 500);
    const { child, base } = await spawnService(built.dir, port, { QUEUE_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    try {
      await fetch(base + '/v1/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: 'over-redis' }),
      });
      const seen = await waitFor(async () => {
        const res = await fetch(base + '/v1/seen');
        const body = await res.json() as string[];
        return Array.isArray(body) && body.includes('over-redis') ? body : null;
      });
      assert.deepEqual(seen, ['over-redis']);
    } finally {
      child.kill('SIGTERM');
    }
  } finally {
    await stopRedis();
  }
});

const STREAM_SPEC = `module streamshare @0.1.0 {
}

use capability arcod.std.kv @1
use capability arcod.std.stream @1

service Hub : http {
  uses store: kv
  uses bus: stream

  contract {
    public op poke(topic: string, message: string) -> number {
      route: "POST /v1/poke"
      effects: bus.publish
      errors: none
    }
  }

  effects {
    allow bus.publish
    deny net, fs, exec
  }
}

environment dev {
  bind store -> redis(host: "kv", port: 6379)
  bind bus -> redis(host: "bus", port: 6379)
  deploy docker
}
`;

test('stream: two replicas see the same websocket events through redis pub/sub', async () => {
  const redisPort = 20000 + Math.floor(Math.random() * 5000);
  const stopRedis = await startFakeRedis(redisPort);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-stream-'));
    const implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, 'poke.mjs'), 'export async function poke(input, io) { return { result: await io.publish(input.topic, input.message) }; }\n');
    const built = await buildExample(parse(STREAM_SPEC, 'main.arc'), dir, { implDir });

    const portA = 19000 + Math.floor(Math.random() * 400);
    const portB = 19400 + Math.floor(Math.random() * 400);
    const replicaA = await spawnService(built.dir, portA, { STREAM_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    const replicaB = await spawnService(built.dir, portB, { STREAM_REDIS_URL: 'redis://127.0.0.1:' + redisPort });
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket('ws://127.0.0.1:' + portB + '/ws?topic=room');
      const ws = socket;
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          const data = JSON.parse(String(event.data)) as { type: string };
          if (data.type === 'ready') resolve();
        };
        ws.onerror = () => reject(new Error('websocket failed'));
      });
      // let the SUBSCRIBE reach the broker before publishing
      await new Promise((resolve) => setTimeout(resolve, 300));

      const poke = await fetch(replicaA.base + '/v1/poke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'room', message: 'hello-replicas' }),
      });
      assert.equal(poke.status, 201);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no event received on replica B: ' + JSON.stringify(received))), 5000);
        ws.onmessage = (event) => {
          received.push(String(event.data));
          const data = JSON.parse(String(event.data)) as { type: string };
          if (data.type !== 'ready') { clearTimeout(timer); resolve(); }
        };
      });
      assert.ok(received.some((text) => text.includes('hello-replicas')), 'replica B delivered the event published on replica A');
    } finally {
      socket?.close();
      replicaA.child.kill('SIGTERM');
      replicaB.child.kill('SIGTERM');
    }
  } finally {
    await stopRedis();
  }
});

const tasksUrl = new URL('../examples/tasks/main.arc', import.meta.url);
const tasksSource = await readFile(tasksUrl, 'utf8');
const tasksAst = parse(tasksSource, 'main.arc');

test('unique names a record field, a declared error and a store (A054-A056)', () => {
  assert.deepEqual(check(tasksAst).filter((item) => item.severity === 'error'), []);

  const missingField = parse(tasksSource.replace('unique Task.title', 'unique Task.subject'), 'main.arc');
  assert.ok(check(missingField).some((item) => item.code === 'A054'));

  const noConflict = parse(tasksSource.replace('error Conflict\n', ''), 'main.arc');
  assert.ok(check(noConflict).some((item) => item.code === 'A055'));

  const noStore = parse(tasksSource.replace('  uses store: kv(ttl: 604800s)\n', ''), 'main.arc');
  assert.ok(check(noStore).some((item) => item.code === 'A056'));
});

test('an explicit effects list is not second-guessed by create/read conventions', () => {
  const codes = check(tasksAst).map((item) => item.code);
  assert.ok(!codes.includes('A004'), 'store.insert does not drag in a phantom store.set');
});

test('the entity store enforces unique, filters, sorts and pages by cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-tasks-'));
  const implDir = fileURLToPath(new URL('../examples/tasks/impl', import.meta.url));
  const built = await buildExample(tasksAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('"prefix": "task:"'), 'the entity owns a key namespace');
  assert.ok(code.includes('"title"'), 'the unique field is part of the generated store table');

  const port = 19900 + Math.floor(Math.random() * 400);
  const service = await spawnService(built.dir, port, {});
  const post = async (path: string, body: unknown) => {
    const res = await fetch(service.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const res = await fetch(service.base + path);
    return { status: res.status, body: (await res.json()) as { items: Array<Record<string, unknown>>; next: string | null } };
  };

  try {
    const first = await post('/v1/tasks', { title: 'ship the store', priority: 3 });
    assert.equal(first.status, 201);
    const duplicate = await post('/v1/tasks', { title: 'ship the store', priority: 9 });
    assert.equal(duplicate.status, 409, 'a claimed title is a declared Conflict, not a 500');
    await post('/v1/tasks', { title: 'write the docs', priority: 2 });
    await post('/v1/tasks', { title: 'review the docs', priority: 1 });

    const page = await get('/v1/tasks?limit=2&sort=priority%20desc');
    assert.deepEqual(page.body.items.map((item) => item.priority), [3, 2]);
    assert.ok(page.body.next, 'a full page carries a cursor');

    const rest = await get('/v1/tasks?limit=2&sort=priority%20desc&cursor=' + encodeURIComponent(page.body.next));
    assert.deepEqual(rest.body.items.map((item) => item.priority), [1]);
    assert.equal(rest.body.next, null);

    const moved = await post('/v1/tasks/' + String(first.body.id) + '/move', { status: 'done' });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.status, 'done');
    assert.ok(moved.body.doneAt);

    const done = await get('/v1/tasks?status=done');
    assert.equal(done.body.items.length, 1);

    const missing = await post('/v1/tasks/00000000-0000-4000-8000-000000000000/move', { status: 'done' });
    assert.equal(missing.status, 404);
  } finally {
    service.child.kill('SIGTERM');
  }
});
test('the service exposes /metrics, request ids and a structured access log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-obs-'));
  const implDir = fileURLToPath(new URL('../examples/tasks/impl', import.meta.url));
  const built = await buildExample(tasksAst, dir, { implDir });
  const port = 19500 + Math.floor(Math.random() * 500);
  const service = await spawnService(built.dir, port, {});

  let logs = '';
  service.child.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });

  try {
    const created = await fetch(service.base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'trace-abc-123' },
      body: JSON.stringify({ title: 'obs task', status: 'open', priority: 1 }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-request-id'), 'trace-abc-123', 'request id is echoed');

    await waitFor(async () => (logs.includes('request_id') ? logs : null));

    const metrics = await (await fetch(service.base + '/metrics')).text();
    assert.ok(metrics.includes('arcod_requests_total{method="POST",route="/v1/tasks",status="201"}'), 'counts the create');
    assert.ok(metrics.includes('arcod_capability_calls_total{capability="store.insert"}'), 'counts the capability call');
    assert.ok(metrics.includes('# TYPE arcod_request_duration_seconds histogram'), 'histogram is typed');
    assert.ok(metrics.includes('arcod_inflight_requests '), 'gauge is present');
    assert.ok(logs.includes('"route":"/v1/tasks"'), 'access log names the route');
  } finally {
    service.child.kill('SIGTERM');
  }
});

test('migrations are deterministic, checksummed and typed', () => {
  const svc = pickService(tasksAst)!;
  const a = migrationPlan(tasksAst, svc);
  const b = migrationPlan(tasksAst, svc);
  assert.deepEqual(a, b, 'the plan is deterministic');

  const kv = a.migrations.find((m) => m.name === 'arcod_kv');
  assert.ok(kv, 'the base blob store is a migration');
  assert.equal(kv!.version, '0001');
  assert.match(kv!.checksum, /^[0-9a-f]{64}$/, 'checksum is sha256 hex');

  const task = a.migrations.find((m) => m.name === 'task');
  assert.ok(task, 'the record type becomes a table');
  assert.ok(task!.up.includes('CREATE TABLE IF NOT EXISTS'), 'apply is idempotent');
  assert.ok(task!.up.includes('PRIMARY KEY (`id`)'), 'id is the primary key');
  assert.ok(task!.up.includes('`title` VARCHAR(191) NOT NULL'), 'unique string is indexed');
  assert.ok(task!.up.includes('UNIQUE KEY `uq_task_title` (`title`)'), 'unique rule becomes a UNIQUE KEY');
  assert.ok(task!.up.includes('`dueAt` DATETIME(3)'), 'optional datetime is nullable');
  assert.ok(task!.down.includes('DROP TABLE'), 'down is generated');

  const tampered = { ...task!, up: task!.up + ' ' };
  assert.notEqual(checksumOf(tampered.up, task!.down), task!.checksum, 'editing changes the checksum');
});

test('the sql service embeds and applies migrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mig-'));
  const sqlUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);
  const sqlAst = parse(await readFile(sqlUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/tasks/impl', import.meta.url));
  const built = await buildExample(sqlAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('const MIGRATIONS = '), 'the changelog is embedded');
  assert.ok(code.includes('arcod_migrations'), 'the bookkeeping table exists');
  assert.ok(code.includes('was edited after it was applied'), 'a checksum mismatch refuses to start');
});

test('the sql service writes records to typed tables, not blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-typed-'));
  const sqlUrl = new URL('../examples/tasks-sql/main.arc', import.meta.url);
  const sqlAst = parse(await readFile(sqlUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/tasks/impl', import.meta.url));
  const built = await buildExample(sqlAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('store.entityFind('), 'the sql store has typed find');
  assert.ok(code.includes('store.entityInsert('), 'the sql store has typed insert');
  assert.ok(code.includes('"table": "task"'), 'the entity is wired to a typed table');
  assert.ok(code.includes('function sqlLiteral('), 'the value codec is emitted');
  assert.ok(code.includes('mysql 1062'), 'a duplicate key surfaces as Conflict');

  const kvDir = await mkdtemp(join(tmpdir(), 'arcod-kv-')); 
  const kvBuilt = await buildExample(tasksAst, kvDir, { implDir });
  const kvCode = await readFile(join(kvBuilt.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(!kvCode.includes('store.entityFind('), 'the kv driver keeps the blob store');
});

test('the outbox makes publish and fact write atomic on sql', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-outbox-'));
  const ordersUrl = new URL('../examples/orders/main.arc', import.meta.url);
  const ordersAst = parse(await readFile(ordersUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/orders/impl', import.meta.url));
  const built = await buildExample(ordersAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('const OUTBOX_OPS = new Set(["create"])'), 'the atomic op is marked');
  assert.ok(code.includes('store.outboxAppend('), 'publish routes through the outbox table');
  assert.ok(code.includes('startOutboxDispatcher()'), 'the dispatcher is wired');
  assert.ok(code.includes('async outboxPending('), 'the store polls pending rows');
  assert.ok(code.includes('if (tx) await store.begin()'), 'the body runs in a transaction');
  assert.ok(code.includes('if (tx) await store.commit()'), 'the transaction commits on success');
  assert.ok(code.includes('if (tx) await store.rollback()'), 'the transaction rolls back on error');

  const plan = migrationPlan(ordersAst, ordersAst.services.find((svc) => !svc.external)!);
  assert.ok(plan.migrations.some((m) => m.name === 'arcod_outbox'), 'the outbox table is migrated');
});

test('sql identifiers are quoted so reserved words are safe table names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-qident-'));
  const ordersUrl = new URL('../examples/orders/main.arc', import.meta.url);
  const ordersAst = parse(await readFile(ordersUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/orders/impl', import.meta.url));
  const built = await buildExample(ordersAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('String.fromCharCode(96)'), 'an identifier quoting helper exists');
  assert.ok(code.includes("q('id')"), 'the id column is quoted');
  assert.ok(code.includes('q(table)'), 'the table name is quoted');
});

test('arcod test executes the given section as state setup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-given-'));
  const project1Url = new URL('../examples/project1/main.arc', import.meta.url);
  const project1Ast = parse(await readFile(project1Url, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/project1/impl', import.meta.url));
  const built = await buildExample(project1Ast, dir, { implDir });
  const report = await runExamples(project1Ast, built.dir);
  const seeded = report.examples.find((e) => e.example === 'seeded_read');
  assert.ok(seeded, 'the seeded_read example ran');
  assert.ok(seeded.ok, 'given setup produced a readable message: ' + (seeded.error ?? ''));
});

test('the service emits operation spans and exports OTLP when asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-trace-'));
  const project1Url = new URL('../examples/project1/main.arc', import.meta.url);
  const project1Ast = parse(await readFile(project1Url, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/project1/impl', import.meta.url));
  const built = await buildExample(project1Ast, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('async function withSpan('), 'the span helper exists');
  assert.ok(code.includes('const spanCtx = new AsyncLocalStorage()'), 'spans are parented via ALS');
  assert.ok(code.includes('startTimeUnixNano'), 'spans carry OTLP timestamps');
  assert.ok(code.includes('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'), 'the OTLP exporter is gated by env');
  assert.ok(code.includes('function flushOtlp()'), 'spans are flushed in batches');
  assert.ok(code.includes('withSpan(opName || routeName'), 'the operation dispatch is wrapped in a span');
});

test('a saga parses, checks and emits the runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-saga-'));
  const sagaUrl = new URL('../examples/saga/main.arc', import.meta.url);
  const sagaAst = parse(await readFile(sagaUrl, 'utf8'), 'main.arc');
  const svc = sagaAst.services.find((s) => s.name === 'Checkout');
  assert.ok(svc, 'the Checkout service exists');
  assert.equal(svc.sagas.length, 1, 'one saga is declared');
  assert.deepEqual(svc.sagas[0].steps.map((st) => st.name), ['mark', 'boom']);
  assert.equal(svc.sagas[0].steps[0].compensate, 'unmark');

  const implDir = fileURLToPath(new URL('../examples/saga/impl', import.meta.url));
  const built = await buildExample(sagaAst, dir, { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('const SAGAS = ['), 'the saga table is emitted');
  assert.ok(code.includes('const OWN_OPS = {'), 'own ops are wired');
  assert.ok(code.includes('async function runSaga('), 'the runner is emitted');
  assert.ok(code.includes('async function sagaInvoke('), 'step invocation is emitted');
  assert.ok(code.includes('(input, io) => runSaga(\"checkout\", input, io)'), 'the job drives the saga');
});

test('saga steps and job references are checked', async () => {
  const badCall = [
    'module m @0.1.0 { }',
    'use capability arcod.std.kv @1',
    'service S : http { uses store: kv contract { public op a() -> string { route: \"GET /a\" } }',
    '  saga broken { step one { call: nope } } }',
  ].join('\n');
  const ast1 = parse(badCall, 'main.arc');
  const d1 = check(ast1).filter((d) => d.code === 'A057');
  assert.ok(d1.length > 0, 'unknown step call is A057');

  const badJob = [
    'module m @0.1.0 { }',
    'use capability arcod.std.kv @1',
    'use capability arcod.std.queue @1',
    'service S : http { uses store: kv uses events: queue contract {',
    '  public op a() -> string { route: \"GET /a\" }',
    '  job j() { on: events.t saga: missing } } }',
  ].join('\n');
  const ast2 = parse(badJob, 'main.arc');
  const d2 = check(ast2).filter((d) => d.code === 'A058');
  assert.ok(d2.length > 0, 'a job saga naming an undeclared saga is A058');
});

test('a failed saga step compensates completed steps in reverse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-saga-e2e-'));
  const sagaUrl = new URL('../examples/saga/main.arc', import.meta.url);
  const sagaAst = parse(await readFile(sagaUrl, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/saga/impl', import.meta.url));
  const built = await buildExample(sagaAst, dir, { implDir });
  const port = 19500 + Math.floor(Math.random() * 400);
  const { child, base } = await spawnService(built.dir, port, {});
  try {
    const res = await fetch(base + '/v1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'saga-1' }),
    });
    assert.equal(res.status, 201);
    const metrics = await waitFor(async () => {
      const text = await (await fetch(base + '/metrics')).text();
      return text.includes('saga.compensate.mark') ? text : null;
    });
    assert.ok(metrics.includes('saga.compensate.mark'), 'the mark step was compensated');
    assert.ok(metrics.includes('saga.checkout.compensated'), 'the saga reports it was compensated');
    assert.ok(!metrics.includes('capability="saga.checkout"}'), 'the saga did not complete');
    const nf = await fetch(base + '/no-such-route');
    assert.equal(nf.status, 404, 'an unmatched route is 404, not 500');
  } finally {
    child.kill('SIGTERM');
  }
});
