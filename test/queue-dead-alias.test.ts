// B115 (issue #61): the capability declared dead(topic) and drop(topic,
// payload), but the emitted io only carried queueDead/queueDeadDrop, so a body
// written against the signature died with "io.dead is not a function" and a
// 500. Both spellings are emitted now, one implementation behind each; these
// tests call the signature names over HTTP and check the bundle carries them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const NL = String.fromCharCode(10);

const spec = [
  'module dlq @0.1.0 {}',
  '',
  'use capability arcod.std.queue @1',
  '',
  'error Invalid',
  '',
  'service Dlq : http {',
  '  uses events: queue',
  '',
  '  effects {',
  '    allow events.dead, events.drop',
  '  }',
  '',
  '  contract {',
  '    public op readDead(topic: string) -> { items: int } {',
  '      route: "POST /v1/dead"',
  '      effects: events.dead',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '',
  '    public op dropIt(topic: string) -> { dropped: bool } {',
  '      route: "POST /v1/drop-alias"',
  '      effects: events.drop',
  '      errors: Invalid',
  '      post: result != null',
  '    }',
  '  }',
  '}',
  '',
].join(NL);

const impl = {
  readDead: [
    'export async function readDead(input, io) {',
    '  const items = await io.dead(String(input.topic || "jobs"));',
    '  return { result: { items: items.length } };',
    '}',
  ].join(NL),
  dropIt: [
    'export async function dropIt(input, io) {',
    '  const dropped = await io.drop(String(input.topic || "jobs"), { id: "absent" });',
    '  return { result: { dropped } };',
    '}',
  ].join(NL),
};

function post(base: string, path: string, body?: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

test('the capability names dead/drop are the methods a body can call', async () => {
  const svc = await startService(spec, { impl });
  try {
    const dead = await post(svc.base, '/v1/dead', { topic: 'jobs' });
    assert.equal(dead.status, 201, 'io.dead answers instead of TypeErrror');
    assert.deepEqual(await dead.json(), { items: 0 });

    const dropped = await post(svc.base, '/v1/drop-alias', { topic: 'jobs' });
    assert.equal(dropped.status, 201, 'io.drop answers instead of TypeError');
    assert.deepEqual(await dropped.json(), { dropped: false });
  } finally {
    await svc.stop();
  }
});

test('the bundle keeps both spellings and each method once', async () => {
  const { emitService } = await import('../src/emit/service.ts');
  const { parse } = await import('../src/parser.ts');
  const source = emitService(parse(spec, 'main.arc'), { impl });
  // The queue driver source also carries a dead(topic), so count inside the io
  // facade only: from makeIo to its closing brace.
  const start = source.indexOf('function makeIo(req) {');
  assert.notEqual(start, -1, 'the bundle carries the io facade');
  const end = source.indexOf(String.fromCharCode(10) + '}', source.indexOf('  };', start));
  const body = source.slice(start, end);
  for (const name of ['dead', 'drop', 'queueDead', 'queueDeadDrop']) {
    const marks = body.match(new RegExp('    async ' + name + '\\(', 'g')) || [];
    assert.equal(marks.length, 1, 'the io facade carries ' + name + ' exactly once');
  }
});
