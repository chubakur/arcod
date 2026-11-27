// B80.3: the cancel path end to end, through a real generated service. The
// unit test drives the consumer directly; here the request travels the wire a
// user would: POST /v1/start publishes a job, the job writes its own message id
// into a record, calls a slow external with io.signal, and POST /v1/cancel
// reads that record and asks the broker to cancel. The external must see its
// connection dropped mid-call, the record must end up 'cancelled', and the
// message must be acked: no retry, nothing in the dead letter list.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildExample } from '../src/build.ts';
import { parse } from '../src/parser.ts';

const spec = [
  'module canceldemo @0.1.0 {}',
  '',
  'use capability arcod.std.kv @1',
  'use capability arcod.std.queue @1',
  '',
  'type Run = {',
  '  id: string,',
  '  state: string',
  '}',
  '',
  'external service Slow : http {',
  '  contract {',
  '    op wait(ms: int) -> { ok: bool } {',
  '      route: "POST /v1/wait"',
  '    }',
  '  }',
  '}',
  '',
  'service Api : http {',
  '  uses store: kv',
  '  uses events: queue',
  '',
  '  contract {',
  '    public op start(ms: int) -> { ok: bool } {',
  '      route: "POST /v1/start"',
  '      effects: events.publish',
  '      status: 202',
  '    }',
  '',
  '    public op cancel() -> { cancelled: int } {',
  '      route: "POST /v1/cancel"',
  '      effects: store.get, events.publish',
  '      status: 200',
  '    }',
  '',
  '    public op state() -> { states: list<string> } {',
  '      route: "GET /v1/state"',
  '      effects: store.get',
  '      status: 200',
  '    }',
  '',
  '    public op dead() -> { items: list<any> } {',
  '      route: "GET /v1/dead"',
  '      effects: events.dead',
  '      status: 200',
  '    }',
  '',
  '    job deploy(ms: int) {',
  '      on: events.jobs',
  '      retry: 0',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '  bind events -> redis(host: "q", port: 6379)',
  '  bind Slow -> endpoint(url: "http://localhost:9009")',
  '  deploy docker',
  '}',
  '',
].join('\n');

const startBody = [
  'export async function start(input, io) {',
  "  await io.queuePublish('jobs', { ms: input.ms });",
  '  return { result: { ok: true } };',
  '}',
  '',
].join('\n');

const cancelBody = [
  'export async function cancel(input, io) {',
  "  const page = await io.find('Run', { where: { state: { eq: 'running' } } });",
  '  let cancelled = 0;',
  '  for (const run of page.items) {',
  "    if (await io.cancelJob('jobs', run.id)) cancelled += 1;",
  '  }',
  '  return { result: { cancelled } };',
  '}',
  '',
].join('\n');

const stateBody = [
  'export async function state(input, io) {',
  "  const page = await io.find('Run', { limit: 10 });",
  '  return { result: { states: page.items.map((run) => run.state) } };',
  '}',
  '',
].join('\n');

const deadBody = [
  'export async function dead(input, io) {',
  "  return { result: { items: await io.queueDead('jobs') } };",
  '}',
  '',
].join('\n');

const deployBody = [
  'export async function deploy(input, io) {',
  '  const id = String(io.messageId);',
  "  await io.insert('Run', { id, state: 'running' });",
  '  try {',
  "    await io.remote('Slow', 'wait', { ms: input.ms }, { signal: io.signal });",
  '  } catch (error) {',
  "    const state = error && error.kind === 'cancelled' ? 'cancelled' : 'failed';",
  "    await io.update('Run', id, { state });",
  '    throw error;',
  '  }',
  "  await io.update('Run', id, { state: 'done' });",
  '  return { result: { done: true } };',
  '}',
  '',
].join('\n');

type Slow = { base: string; requests: number; aborted: number; close: () => Promise<void> };

// The external answers only after `ms`; a client that hangs up first is the
// proof that the abort reached fetch rather than the body merely giving up.
function slowServer(ms: number): Promise<Slow> {
  const state = { requests: 0, aborted: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.requests += 1;
      const timer = setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, ms);
      res.on('close', () => {
        if (!res.writableEnded) {
          state.aborted += 1;
          clearTimeout(timer);
        }
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        base: 'http://127.0.0.1:' + port,
        get requests() { return state.requests; },
        get aborted() { return state.aborted; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  return new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for ' + what);
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, init?.method + ' ' + url + ' answered ' + response.status);
  return response.json();
}

test('an operation cancels a running job through the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-cancel-'));
  const slow = await slowServer(1500);
  let child: ReturnType<typeof spawn> | null = null;
  const output: string[] = [];
  try {
    await mkdir(join(dir, 'impl'), { recursive: true });
    await writeFile(join(dir, 'impl', 'start.mjs'), startBody, 'utf8');
    await writeFile(join(dir, 'impl', 'cancel.mjs'), cancelBody, 'utf8');
    await writeFile(join(dir, 'impl', 'state.mjs'), stateBody, 'utf8');
    await writeFile(join(dir, 'impl', 'dead.mjs'), deadBody, 'utf8');
    await writeFile(join(dir, 'impl', 'deploy.mjs'), deployBody, 'utf8');
    const built = await buildExample(parse(spec, 'main.arc'), dir, { implDir: join(dir, 'impl') });

    const port = await freePort();
    child = spawn(process.execPath, [join(built.dir, 'service', 'index.mjs')], {
      env: {
        ...process.env,
        KV_DRIVER: 'memory',
        PORT: String(port),
        SLOW_URL: slow.base,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const base = 'http://127.0.0.1:' + port;
    await waitFor('the service to listen', async () => {
      try {
        const probe = await fetch(base + '/v1/state');
        return probe.ok;
      } catch {
        if (child?.exitCode !== null) throw new Error('service exited: ' + output.join(''));
        return false;
      }
    });

    const started = await fetch(base + '/v1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 1500 }),
    });
    assert.equal(started.status, 202, 'the start op answered ' + started.status);
    await waitFor('the job to reach the external', async () => slow.requests === 1);

    const cancelAt = Date.now();
    const cancelled = await json(base + '/v1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelled.cancelled, 1, 'the operation found the running job by its published id');

    // The external sees the socket close while it is still holding the reply:
    // the abort travelled through io.signal into fetch, it did not wait out the
    // call and then discard the answer.
    await waitFor('the external to see the abort', async () => slow.aborted === 1);
    await waitFor('the run to be marked cancelled', async () => {
      const page = await json(base + '/v1/state');
      return page.states.includes('cancelled');
    });
    assert.ok(Date.now() - cancelAt < 1000, 'the call was cut, not waited out');

    // Ack, not retry: the ack happens after the body returned, so a retry would
    // show up as a second external request and a dead letter as a non-empty
    // list. Both are checked after the retry budget would have expired.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(slow.requests, 1, 'a cancelled job is not retried');
    const dead = await json(base + '/v1/dead');
    assert.deepEqual(dead.items, [], 'a cancelled job is not dead-lettered');
    const finalState = await json(base + '/v1/state');
    assert.deepEqual(finalState.states, ['cancelled'], 'the body observed the cancel');
  } finally {
    child?.kill('SIGKILL');
    await slow.close();
    await rm(dir, { recursive: true, force: true });
  }
});
