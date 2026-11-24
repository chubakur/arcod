// The body ceiling is documented as a 400 Invalid, and it used to be a reset
// socket above CONFIG.maxBody + 4096: the reader destroyed the request the
// moment it saw the limit, so the handler's 400 had nowhere to go and the
// caller saw "other side closed"/ECONNRESET — a network failure instead of a
// described refusal. The three sizes below pin the whole ladder: under the
// ceiling (accepted), over maxBody but inside the read ceiling (400 from the
// size check), and far over the read ceiling (400 from the reader).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startService } from './harness.ts';

const source = await readFile(new URL('../examples/onetimemessage/main.arc', import.meta.url), 'utf8');

async function post(base: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(base + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, text: await response.text() };
}

test('a body far over the read ceiling is a 400, not a reset connection', async () => {
  const svc = await startService(source, { reference: true });
  try {
    const huge = JSON.stringify({ body: 'x'.repeat(200 * 1024) });
    const answer = await post(svc.base, huge);
    assert.equal(answer.status, 400);
    assert.match(answer.text, /"error":"Invalid"/);

    // The socket is still usable: the same connection pool can ask again.
    const small = await post(svc.base, JSON.stringify({ body: 'hi' }));
    assert.equal(small.status, 201, 'the service stopped answering after a refused body');
  } finally {
    await svc.stop();
  }
});

test('a body over maxBody but inside the read ceiling answers 400 Invalid', async () => {
  const svc = await startService(source, { reference: true });
  try {
    const over = JSON.stringify({ body: 'x'.repeat(66 * 1024) });
    const answer = await post(svc.base, over);
    assert.equal(answer.status, 400);
    assert.match(answer.text, /"error":"Invalid"/);
  } finally {
    await svc.stop();
  }
});

test('a body under the ceiling is still accepted', async () => {
  const svc = await startService(source, { reference: true });
  try {
    const ok = await post(svc.base, JSON.stringify({ body: 'y'.repeat(8 * 1024) }));
    assert.equal(ok.status, 201);
  } finally {
    await svc.stop();
  }
});
