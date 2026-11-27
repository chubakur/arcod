// The consumer half of the Go kit (B111.2): a job operation is no longer
// refused by name — the service gets a consumer loop in main.go, a body in
// ops.go, and the receive/requeue/dead calls in arcodio/queue.go. These are the
// text rules; test/go-job-live.test.ts proves the loop against a real service.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';
import { goJobs, goMain, goOps, goQueueBound, goUnsupported } from '../src/emit/go.ts';

const header =
  'module orders @0.1.0 {}\n\n' +
  'use capability arcod.std.kv @1\n' +
  'use capability arcod.std.queue @1\n\n' +
  'type OrderId = uuid\n' +
  'error Invalid\n\n' +
  'service Orders : http {\n' +
  '  language: go\n';
const footer = '\n}\n';
const module = (body: string): string => header + body + footer;

const withJob = [
  '  uses store: kv',
  '  uses events: queue',
  '',
  '  contract {',
  '    public op place(id: OrderId) -> { id: OrderId } {',
  '      route: "POST /v1/orders"',
  '      errors: Invalid',
  '      status: 201',
  '    }',
  '',
  '    job fulfil(id: OrderId) {',
  '      on: events.orders',
  '      retry: 2',
  '    }',
  '  }',
].join('\n');

test('a queue-backed job is carried, not refused', () => {
  const mod = parse(module(withJob), 'main.arc');
  const svc = mod.services[0]!;
  assert.deepEqual(goUnsupported(mod, svc), []);
  assert.equal(goQueueBound(svc), true);
  assert.deepEqual(goJobs(svc), [{ name: 'fulfil', topic: 'orders', params: ['id'], retry: 2 }]);
});

test('a job that drives a saga is still refused by name', () => {
  const source = module([
    '  uses store: kv',
    '  uses events: queue',
    '',
    '  contract {',
    '    job fulfil(id: OrderId) {',
    '      on: events.orders',
    '      saga: checkout',
    '    }',
    '  }',
    '',
    '  saga checkout {',
    '    step mark { call: fulfil }',
    '  }',
  ].join('\n'));
  const mod = parse(source, 'main.arc');
  const names = goUnsupported(mod, mod.services[0]!);
  assert.ok(names.includes('saga job fulfil'), names.join(', '));
});

test('the queue file is emitted for a job-only service, and the loop starts with the service', () => {
  const mod = parse(module(withJob), 'main.arc');
  const svc = mod.services[0]!;
  const main = goMain(mod, svc);
  assert.match(main, /go consumeFulfil\(arc\)/);
  assert.match(main, /arc\.QueueReceive\(topic\)/);
  assert.match(main, /const retry = 2/);
  assert.match(main, /arc\.QueueDead\(topic, string\(entry\)\)/);
  assert.match(main, /arc\.QueueRequeue\(topic, string\(entry\)\)/);
  // The job input is mapped the way the Node runtime maps it: one parameter
  // takes the field of that name, or the payload when it has no such key.
  assert.match(main, /jobInput\(\[\]string\{"id"\}, envelope\.Payload\)/);
  assert.match(main, /"consumer returned no result for its input"/);
  // A time import the loop uses; without it the generated service would not
  // compile, and an unused import would not compile either.
  assert.match(main, /\t"time"\n/);
});

test('a job body is spliced into ops.go under a job comment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-gojob-emit-'));
  try {
    await mkdir(join(dir, 'impl'), { recursive: true });
    const body = 'func opFulfil(io *arcodio.IO, in map[string]any) (any, error) {\n\treturn nil, ErrInvalid\n}\n';
    await writeFile(join(dir, 'impl', 'fulfil.go'), body, 'utf8');
    await buildExample(parse(module(withJob), 'main.arc'), dir, { reference: true });
    const ops = await readFile(join(dir, '.arcod', 'build', 'service', 'ops.go'), 'utf8');
    assert.match(ops, /\/\/ opFulfil implements job fulfil off queue orders\./);
    assert.equal(ops.match(/func opFulfil\(/g)?.length, 1, 'the body replaced the stub');
    // The http stub is still there: a job body must not swallow another op.
    assert.match(ops, /func opPlace\(io \*arcodio\.IO, in map\[string\]any\) \(any, error\) \{/);
    const queue = await readFile(join(dir, '.arcod', 'build', 'service', 'arcodio', 'queue.go'), 'utf8');
    assert.match(queue, /func \(io \*IO\) QueueReceive\(topic string\) \(string, bool, error\) \{/);
    assert.match(queue, /func \(io \*IO\) QueueRequeue\(topic, text string\) error \{/);
    assert.match(queue, /func \(io \*IO\) QueueDead\(topic, text string\) error \{/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('goOps without bodies stubs a job by name', () => {
  const mod = parse(module(withJob), 'main.arc');
  const ops = goOps(mod, mod.services[0]!);
  assert.match(ops, /func opFulfil\(io \*arcodio\.IO, in map\[string\]any\) \(any, error\) \{/);
  assert.match(ops, /NotImplemented/);
});
