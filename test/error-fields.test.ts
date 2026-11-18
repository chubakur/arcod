import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

// An error may declare payload fields. The 409 body carries exactly the
// declared names the body provided — nothing else, so a body cannot smuggle
// extra properties into the error document.

const SPEC = [
  'module locks @0.1.0 {}',
  'use capability arcod.std.kv @1',
  'type Note = { id: uuid, fence: int }',
  'error Invalid',
  'error Conflict { fence: int }',
  'service Locks : http {',
  '  uses store: kv(ttl: 1h)',
  '  effects { allow store.insert }',
  '  rules { unique Note.fence }',
  '  contract {',
  '    public op lock(fence: int) -> Note {',
  '      route: "POST /v1/locks"',
  '      effects: store.insert',
  '      errors: Invalid, Conflict',
  '      on error Conflict: fence != null',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind store -> redis(host: "kv", port: 6379)',
  '}',
  '',
].join('\n');

test('a declared error field reaches the 409 body, undeclared ones do not', async () => {
  const impl = {
    lock: [
      'export async function lock(input, io) {',
      '  return { error: \'Conflict\', fence: Number(input.fence), secret: \'x\' };',
      '}',
      '',
    ].join('\n'),
  };
  const svc = await startService(SPEC, { impl });
  try {
    const res = await fetch(svc.base + '/v1/locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fence: 5 }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'Conflict');
    assert.equal(body.fence, 5, 'the declared fence is echoed');
    assert.equal('secret' in body, false, 'an undeclared field is dropped');
  } finally {
    await svc.stop();
  }
});

test('an error without declared fields keeps the classic body', async () => {
  const spec = SPEC.replace('error Conflict { fence: int }', 'error Conflict');
  const impl = {
    lock: [
      'export async function lock(input, io) {',
      '  return { error: \'Conflict\', fence: 5 };',
      '}',
      '',
    ].join('\n'),
  };
  const svc = await startService(spec, { impl });
  try {
    const res = await fetch(svc.base + '/v1/locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fence: 5 }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Conflict', message: 'conflict' });
  } finally {
    await svc.stop();
  }
});
