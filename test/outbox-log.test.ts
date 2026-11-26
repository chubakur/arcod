import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_SOURCE } from '../src/emit/queue.ts';

// The dispatcher sweeps continuously: with a dead broker it retried every row
// of every sweep and wrote a line each time, tens of thousands a minute. The
// log is now one line per kind per 30 seconds, and the first failure is kept.

function load(stores: unknown, publish: (topic: string, text: string) => Promise<void>, log: string[]) {
  const factory = new Function('process', 'store', 'SqlStore', 'queuePublishDriver', 'setTimeout', 'console',
    OUTBOX_SOURCE + '\nreturn { runOutboxDispatcher, stop() { outboxStopped = true; } };');
  const console = {
    error: (...parts: unknown[]) => log.push(parts.join(' ')),
    warn: (...parts: unknown[]) => log.push(parts.join(' ')),
  };
  const loaded = factory({ env: { SQL_DRIVER: 'memory' } }, stores, function SqlStore() {}, publish, setTimeout, console) as {
    runOutboxDispatcher: () => Promise<void>;
    stop: () => void;
  };
  return loaded;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a dead broker writes one outbox line, not one per row per sweep', async () => {
  const log: string[] = [];
  let publishes = 0;
  let sweeps = 0;
  const store = {
    async outboxPending() {
      sweeps += 1;
      if (sweeps > 3) return []; // an empty sweep sleeps, so timers get a turn
      return [
        { id: '1', topic: 'jobs', payload: '{}' },
        { id: '2', topic: 'jobs', payload: '{}' },
      ];
    },
    async outboxMark() {},
  };
  const loaded = load(store, async () => { publishes += 1; throw new Error('broker down'); }, log);
  const run = loaded.runOutboxDispatcher();
  await sleep(20);
  loaded.stop();
  await run;
  assert.equal(publishes, 6, 'six failed publishes over three sweeps');
  assert.equal(log.length, 1, 'one line for a storm of failures');
  assert.match(log[0], /outbox publish failed:/);
  assert.match(log[0], /broker down/);
});

test('an unreadable store keeps the outbox poll line', async () => {
  const log: string[] = [];
  const store = {
    async outboxPending() { throw new Error('store gone'); },
    async outboxMark() {},
  };
  const loaded = load(store, async () => {}, log);
  const run = loaded.runOutboxDispatcher();
  await sleep(20);
  loaded.stop();
  await run;
  assert.equal(log.length, 1);
  assert.match(log[0], /outbox poll failed:/);
  assert.match(log[0], /store gone/);
});
