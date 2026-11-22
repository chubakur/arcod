import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_IMPL, formatImplReport, runImpl } from '../src/impl.ts';
import { parse } from '../src/parser.ts';

// runImpl is the door to the model. Only the wire behaviour can be tested
// without a model installed, so these cases stand a mock Ollama in front of it
// and pin what the runner does with every kind of answer.

const SPEC = `module demo @0.1.0 {
  meta { owner: "@you" }
}

service Ping : http {
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      post: result == "pong"
    }
  }
}
`;

const BODY = 'export async function ping(input, io) {\n  return "pong";\n}\n';

interface Reply { status?: number; body: unknown }

async function mockModel(replies: Reply[]): Promise<{ endpoint: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { requests.push(JSON.parse(raw)); } catch { requests.push({ raw }); }
      const reply = replies.shift() ?? { body: { response: '' } };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: 'http://127.0.0.1:' + port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-impl-'));
  await writeFile(join(dir, 'main.arc'), SPEC, 'utf8');
  return dir;
}

test('a fenced answer becomes a body with provenance on it', async () => {
  const model = await mockModel([{ body: { response: 'Here you go:\n```js\n' + BODY + '```\n' } }]);
  try {
    const dir = await project();
    const mod = parse(SPEC, 'main.arc');
    const { results, options } = await runImpl(mod, dir, { endpoint: model.endpoint, cache: false });
    assert.equal(options.model, DEFAULT_IMPL.model);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].error ?? '');
    const written = await readFile(join(dir, 'impl', 'ping.mjs'), 'utf8');
    assert.match(written, /^\/\/ @arcod generated: op ping · prompt [0-9a-f]{12} · model /);
    assert.match(written, new RegExp('export async function ping'));

    const sent = model.requests[0];
    assert.equal(sent.model, DEFAULT_IMPL.model);
    assert.equal(sent.stream, false);
    assert.match(sent.system, /one JavaScript function/, 'the system prompt frames the job');
    assert.match(sent.system, /No imports, no HTTP/, 'and the sandbox rules it will be judged by');
    assert.equal(typeof sent.prompt, 'string');
  } finally {
    await model.close();
  }
});

test('a second run answers from the cache instead of the model', async () => {
  const model = await mockModel([{ body: { response: BODY } }]);
  try {
    const dir = await project();
    const mod = parse(SPEC, 'main.arc');
    const first = await runImpl(mod, dir, { endpoint: model.endpoint });
    assert.equal(first.results[0].ok, true, first.results[0].error ?? '');
    assert.equal(first.results[0].cached, false);

    const second = await runImpl(mod, dir, { endpoint: model.endpoint });
    assert.equal(second.results[0].ok, true);
    assert.equal(second.results[0].cached, true);
    assert.equal(model.requests.length, 1, 'the cache spared the second request');
    assert.ok((await readdir(join(dir, '.arcod', 'cache'))).length > 0);
  } finally {
    await model.close();
  }
});

test('a body that does not export the operation is rejected, not written', async () => {
  const model = await mockModel([{ body: { response: 'export async function other() { return 1; }' } }]);
  try {
    const dir = await project();
    const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: model.endpoint, cache: false });
    assert.equal(results[0].ok, false);
    assert.match(results[0].error ?? '', /expected export async function ping/);
    assert.deepEqual(await readdir(join(dir, 'impl')).catch(() => []), []);
  } finally {
    await model.close();
  }
});

test('a body that reaches for the host is refused by the sandbox', async () => {
  const escaping = 'import { readFile } from "node:fs/promises";\nexport async function ping() { return readFile("/etc/passwd", "utf8"); }';
  const model = await mockModel([{ body: { response: escaping } }]);
  try {
    const dir = await project();
    const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: model.endpoint, cache: false });
    assert.equal(results[0].ok, false);
    assert.ok((results[0].error ?? '').length > 0, 'the refusal says why');
  } finally {
    await model.close();
  }
});

test('a model error is reported per operation, not thrown', async () => {
  const failing = await mockModel([{ status: 500, body: { error: 'model not loaded' } }]);
  try {
    const dir = await project();
    const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: failing.endpoint, cache: false });
    assert.equal(results[0].ok, false);
    assert.match(results[0].error ?? '', /ollama 500 .*model not loaded/);
  } finally {
    await failing.close();
  }

  const empty = await mockModel([{ body: {} }]);
  try {
    const dir = await project();
    const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: empty.endpoint, cache: false });
    assert.match(results[0].error ?? '', /empty response/);
  } finally {
    await empty.close();
  }
});

test('an unreachable model says so in words a user can act on', async () => {
  const dir = await project();
  const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: 'http://127.0.0.1:1', cache: false, timeoutMs: 2000 });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /cannot reach http:\/\/127\.0\.0\.1:1 .*ollama running/);
});

test('a dry run reports the prompt without sending it', async () => {
  const model = await mockModel([{ body: { response: BODY } }]);
  try {
    const dir = await project();
    const { results } = await runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: model.endpoint, dryRun: true });
    assert.equal(results[0].error, 'dry run: prompt not sent');
    assert.equal(model.requests.length, 0);
  } finally {
    await model.close();
  }
});

test('a remote endpoint needs an explicit allow-remote', async () => {
  const dir = await project();
  await assert.rejects(
    () => runImpl(parse(SPEC, 'main.arc'), dir, { endpoint: 'https://api.example.com' }),
    /refusing to send prompts to https:\/\/api\.example\.com.*--allow-remote/,
  );
});

test('formatImplReport marks ok, cached and failed bodies', () => {
  const report = formatImplReport([
    // The report names the operation; the task id stays internal.
    { id: 'T-0001', op: 'ping', file: '/tmp/ping.mjs', ok: true, cached: false, tokens: 10, bytes: 120 },
    { id: 'T-0002', op: 'echo', file: '/tmp/echo.mjs', ok: true, cached: true, tokens: 12, bytes: 90 },
    { id: 'T-0003', op: 'read', file: '/tmp/read.mjs', ok: false, cached: false, tokens: 9, bytes: 0, error: 'syntax error' },
  ], { ...DEFAULT_IMPL, model: 'qwen2.5-coder' });
  assert.match(report, /^impl: 2\/3 bodies, model qwen2\.5-coder/);
  assert.match(report, /context: num_ctx=\d+, temperature=[\d.]+, seed=\d+/);
  assert.match(report, /ok +ping +\d+ bytes/);
  assert.match(report, /ok +echo cached/);
  assert.match(report, /fail read +syntax error/);
});
