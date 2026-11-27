// Two transactional operations used to share one transaction: the store is a
// single connection, so the second BEGIN landed inside the first, a duplicate
// id aborted it, and the loser's ROLLBACK discarded the winner's row while the
// winner answered 500 (issue #57). A transaction now holds the store gate
// exclusively; ordinary requests take it shared and wait while it is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TX_GATE_SOURCE } from '../src/emit/tx-gate.ts';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

interface Gate {
  share: (fn: () => Promise<unknown>) => Promise<unknown>;
  hold: (fn: () => Promise<unknown>) => Promise<unknown>;
}

const gate = (): Gate => (new Function(TX_GATE_SOURCE + String.fromCharCode(10) + 'return createTxGate;')() as () => Gate)();

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a second transaction waits for the first to commit', async () => {
  const g = gate();
  const first = deferred();
  const log: string[] = [];
  const a = g.hold(async () => { log.push('a:begin'); await first.promise; log.push('a:commit'); });
  await tick();
  const b = g.hold(async () => { log.push('b:begin'); log.push('b:commit'); });
  await tick();
  assert.deepEqual(log, ['a:begin'], 'the second body does not start inside the first transaction');
  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a:begin', 'a:commit', 'b:begin', 'b:commit']);
});

test('ordinary requests wait while a transaction is open', async () => {
  const g = gate();
  const release = deferred();
  const log: string[] = [];
  const tx = g.hold(async () => { log.push('tx:begin'); await release.promise; log.push('tx:commit'); });
  await tick();
  const read = g.share(async () => { log.push('read'); return 'row'; });
  await tick();
  assert.deepEqual(log, ['tx:begin'], 'a read would see uncommitted rows on the shared connection');
  release.resolve();
  assert.equal(await read, 'row');
  await tx;
  assert.deepEqual(log, ['tx:begin', 'tx:commit', 'read']);
});

test('without a transaction, ordinary requests still overlap', async () => {
  const g = gate();
  const log: string[] = [];
  const a = g.share(async () => { log.push('a:start'); await tick(); log.push('a:end'); });
  const b = g.share(async () => { log.push('b:start'); await tick(); log.push('b:end'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a:start', 'b:start', 'a:end', 'b:end']);
});

test('a failed transaction releases the store for the next request', async () => {
  const g = gate();
  await assert.rejects(() => g.hold(async () => { throw Object.assign(new Error('dup'), { error: 'Conflict' }); }));
  assert.equal(await g.share(async () => 'ok'), 'ok');
  assert.equal(await g.hold(async () => 'next'), 'next');
});

test('the emitted service runs a transactional body inside the gate', async () => {
  const mod = parse(await readFile(new URL('../examples/orders/main.arc', import.meta.url), 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/orders/impl', import.meta.url));
  const built = await buildExample(mod, await mkdtemp(join(tmpdir(), 'arcod-tx-gate-')), { implDir });
  const code = await readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.ok(code.includes('function createTxGate()'));
  assert.ok(code.includes('const STORE_GATE = createTxGate();'));
  assert.ok(code.includes('out = await STORE_GATE.hold(async () => {'));
  assert.ok(code.includes('out = await STORE_GATE.share(() => implFn(input, io));'));
  assert.ok(!code.includes('if (tx) await store.begin();'));
  // begin/commit/rollback live inside the held body, not around it.
  const from = code.indexOf('out = await STORE_GATE.hold');
  const region = code.slice(from, code.indexOf('out = await STORE_GATE.share'));
  assert.ok(region.includes('await store.begin();'));
  assert.ok(region.includes('await store.commit();'));
  assert.ok(region.includes('await store.rollback();'));
});

