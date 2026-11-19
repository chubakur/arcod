import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parser.ts';
import { formatPipeline, runPipeline, type PipelineResult } from '../src/pipeline.ts';

// `arcod make` is one loop with five exits, and every exit is a decision the
// user has to understand: did we talk to the model, did we rebuild, did we run
// the examples? These tests pin the branches the happy path never reaches.

const BARE = `module demo @0.1.0 {
  meta {
    owner: "@you"
    status: draft
    since: "2026-11-17"
  }
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

const WITH_EXAMPLE = `module demo @0.1.0 {
  meta {
    owner: "@you"
    status: draft
    since: "2026-11-17"
  }
}

service Ping : http {
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      post: result == "pong"
    }

    public op echo(text: string) -> string {
      route: "POST /v1/echo"
      post: result == text
    }
  }

  examples {
    example ping_ok {
      when { let r = ping() }
      then { r == "pong" }
    }
  }
}
`;

async function project(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pipeline-'));
  await writeFile(join(dir, 'main.arc'), source, 'utf8');
  return dir;
}

test('formatPipeline marks skipped, ok and failed steps apart', () => {
  const result: PipelineResult = {
    ok: false,
    dir: '/tmp/x',
    buildDir: '/tmp/x/.arcod/build',
    steps: [
      { name: 'check', ok: true, detail: '0 error(s)', ms: 2 },
      { name: 'prompts', ok: true, detail: 'nothing to ask', skipped: true, ms: 0 },
      { name: 'impl', ok: false, detail: '1 failed', error: 'ping: model timed out', ms: 30 },
    ],
  };
  const text = formatPipeline(result, 'demo@0.1.0');
  assert.match(text, /^arcod make: demo@0\.1\.0/);
  assert.match(text, /check +ok +0 error\(s\)/);
  assert.match(text, /prompts +skip +nothing to ask/);
  assert.match(text, /impl +fail +1 failed/);
  assert.match(text, /\n {11}ping: model timed out/);
  assert.match(text, /stopped in 32 ms$/);
  assert.doesNotMatch(text, /done in/, 'a failed pipeline never claims to be done');
});

test('a scaffold build with no tests still walks every step', async () => {
  const dir = await project(WITH_EXAMPLE);
  const result = await runPipeline(parse(WITH_EXAMPLE, 'main.arc'), dir, {
    skipImpl: true,
    noTest: true,
  });
  assert.ok(result.ok, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map((step) => step.name), ['check', 'prompts', 'impl', 'build', 'test']);
  assert.match(result.steps[2].detail, /skipped \(--skip-impl\)/);
  assert.match(result.steps[3].detail, /^scaffold · /);
  assert.match(result.steps[4].detail, /skipped \(--no-test\)/);
  assert.ok(result.buildDir && result.buildDir.endsWith(join('.arcod', 'build')));
  // The two manifest locations must hold the same task list: the build writes
  // the one inside prompts/, the prompts step must not leave an older copy.
  const loose = JSON.parse(await readFile(join(result.buildDir, 'prompts.json'), 'utf8'));
  const beside = JSON.parse(await readFile(join(result.buildDir, 'prompts', 'manifest.json'), 'utf8'));
  assert.deepEqual(beside, loose);
});

test('bodies already in impl/ skip both the model and the rewrite', async () => {
  const dir = await project(WITH_EXAMPLE);
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'ping.mjs'), 'export async function ping() { return "pong"; }\n', 'utf8');
  await writeFile(join(dir, 'impl', 'echo.mjs'), 'export async function echo(input) { return input.text; }\n', 'utf8');
  const result = await runPipeline(parse(WITH_EXAMPLE, 'main.arc'), dir, { noTest: true });
  assert.ok(result.ok, JSON.stringify(result.steps));
  const prompts = result.steps.find((step) => step.name === 'prompts')!;
  assert.ok(prompts.skipped);
  assert.match(prompts.detail, /2\/2 bodies already in impl\//);
  const impl = result.steps.find((step) => step.name === 'impl')!;
  assert.ok(impl.skipped);
  assert.match(impl.detail, /use --force to regenerate/);
});

test('a spec with no examples reports the test step as skipped, not passed', async () => {
  const dir = await project(BARE);
  const result = await runPipeline(parse(BARE, 'main.arc'), dir, { skipImpl: true });
  assert.ok(result.ok, JSON.stringify(result.steps));
  const testStep = result.steps.find((step) => step.name === 'test')!;
  assert.ok(testStep.skipped);
  assert.match(testStep.detail, /nothing to check/);
});

// A model that reaches for the network produces a body runImpl refuses. The
// failure has to stop `make` at the impl step with the operation named, not
// fall through to a build that would embed a body nobody accepted.
test('a model body that fails the sandbox stops the pipeline at impl', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'export async function ping() {\n  await fetch("http://example.com");\n  return "pong";\n}' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    const dir = await project(BARE);
    const result = await runPipeline(parse(BARE, 'main.arc'), dir, { endpoint, noTest: true });
    assert.equal(result.ok, false);
    const impl = result.steps.find((step) => step.name === 'impl')!;
    assert.equal(impl.ok, false);
    assert.match(impl.detail, /1 failed/);
    assert.match(impl.error ?? '', /body must not use raw network/);
    assert.ok(!result.steps.some((step) => step.name === 'build'), 'nothing is built from a refused body');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a body that breaks its example fails the pipeline and names the example', async () => {
  const dir = await project(WITH_EXAMPLE);
  await mkdir(join(dir, 'impl'), { recursive: true });
  await writeFile(join(dir, 'impl', 'ping.mjs'), 'export async function ping() { return "nope"; }\n', 'utf8');
  await writeFile(join(dir, 'impl', 'echo.mjs'), 'export async function echo(input) { return input.text; }\n', 'utf8');
  const result = await runPipeline(parse(WITH_EXAMPLE, 'main.arc'), dir, { skipImpl: true });
  assert.equal(result.ok, false);
  const testStep = result.steps.find((step) => step.name === 'test')!;
  assert.equal(testStep.ok, false);
  assert.match(testStep.detail, /failed/);
  assert.match(testStep.error ?? '', /ping_ok/);
});
