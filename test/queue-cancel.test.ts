// B80.2: a job owns an AbortController. A cancel request travels through the
// broker as a flag keyed by the message id, the consumer polls it while the
// body runs and aborts the signal the body hands to io.remote. A cancelled
// message is acked: no retry, no dead letter, one log line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_SOURCE, consumerSource } from '../src/emit/queue.ts';

function loadMemory() {
  const factory = new Function('process', 'setTimeout', 'clearTimeout',
    QUEUE_SOURCE + '\nreturn { queueDriver };');
  return factory({ env: {} }, setTimeout, clearTimeout) as {
    queueDriver: {
      cancel(topic: string, id: string): Promise<boolean>;
      isCancelled(topic: string, id: string): Promise<boolean>;
      forgetCancel(topic: string, id: string): Promise<boolean>;
    };
  };
}

test('memory: a cancel flag is set, read and dropped', async () => {
  const { queueDriver } = loadMemory();
  assert.equal(await queueDriver.isCancelled('jobs', 'm1'), false, 'nothing requested yet');
  await queueDriver.cancel('jobs', 'm1');
  assert.equal(await queueDriver.isCancelled('jobs', 'm1'), true);
  assert.equal(await queueDriver.isCancelled('jobs', 'm2'), false, 'the flag is per message');
  await queueDriver.forgetCancel('jobs', 'm1');
  assert.equal(await queueDriver.isCancelled('jobs', 'm1'), false);
});

type Job = { calls: Array<[string, string]>; log: string[]; run: Promise<void>; stop: () => void };

function consumerRun(body: (input: unknown, io: any) => Promise<unknown>, retry = 1): Job {
  const src = consumerSource([{ topic: 'jobs', handler: 'work', params: ['id'], retry }]);
  const calls: Array<[string, string]> = [];
  const log: string[] = [];
  let delivered = false;
  const queueDriver = {
    async receive() {
      if (delivered) return null;
      delivered = true;
      return JSON.stringify({ payload: { id: '7' }, attempts: 0, id: 'm1' });
    },
    async isCancelled() { return true; },
    async forgetCancel() { return true; },
    async requeue(_topic: string, raw: string) { calls.push(['requeue', raw]); },
    async toDead(_topic: string, raw: string) { calls.push(['dead', raw]); },
  };
  const makeIo = (req: any) => ({ signal: req.signal, messageId: req.messageId });
  const fakeConsole = { warn: (line: string) => log.push(line), error: (line: string) => log.push(line) };
  const factory = new Function('queueDriver', 'makeIo', 'setTimeout', 'QUEUE_POLL_MS', 'process', 'console', 'work',
    src + '\nreturn { runConsumer, stop() { consumersStopped = true; } };');
  const loaded = factory(queueDriver, makeIo, setTimeout, 1, null, fakeConsole, body) as {
    runConsumer: (spec: unknown) => Promise<void>;
    stop: () => void;
  };
  const run = loaded.runConsumer({ topic: 'jobs', fn: body, params: ['id'], retry });
  return { calls, log, run, stop: loaded.stop };
}

async function settle(job: Job, ms: number) {
  const started = Date.now();
  while (job.log.length === 0 && Date.now() - started < ms) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  job.stop();
  await job.run;
}

test('the polled flag aborts io.signal while the body is inside a call', async () => {
  let seen: { messageId: unknown; hasSignal: boolean } | null = null;
  const job = consumerRun(async (_input, io) => {
    seen = { messageId: io.messageId, hasSignal: !!io.signal };
    await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('the signal was never aborted')), 2000);
      io.signal.addEventListener('abort', () => { clearTimeout(guard); resolve(null); });
    });
    // The body turns the abort into the documented error, as io.remote does.
    const cancelled = new Error('remote: Slow.ping cancelled');
    cancelled.kind = 'cancelled';
    throw cancelled;
  });
  await settle(job, 1500);
  assert.deepEqual(seen, { messageId: 'm1', hasSignal: true });
  assert.deepEqual(job.calls, [], 'a cancelled job is acked, not requeued or dead-lettered');
  assert.equal(job.log.length, 1);
  assert.match(job.log[0], /job cancelled, message acknowledged/);
  assert.doesNotMatch(job.log[0], /\{/, 'the line carries no payload');
});

test('a cancelled error is not retried and not dead-lettered', async () => {
  const job = consumerRun(async () => {
    const cancelled = new Error('remote: Slow.ping cancelled');
    cancelled.kind = 'cancelled';
    throw cancelled;
  }, 2);
  await settle(job, 500);
  assert.deepEqual(job.calls, []);
  assert.match(job.log[0] || '', /job cancelled/);
});

test('an ordinary failure still follows retry and dead letter', async () => {
  const job = consumerRun(async () => { throw new Error('boom'); }, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  job.stop();
  await job.run;
  assert.equal(job.calls.length, 1);
  assert.equal(job.calls[0][0], 'dead');
  assert.match(JSON.parse(job.calls[0][1]).lastError, /boom/);
});
