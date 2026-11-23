// One socket carries one MySQL packet sequence at a time. The connection kept
// a single `pending` waiter and reset `seq` at the start of every statement, so
// two concurrent io calls (a queue consumer and an HTTP request) overwrote each
// other: `find` decoded another entity's rows positionally and Promise.all of
// four counts answered zeros. The statement queue serializes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SQL_STORE_SOURCE } from '../src/emit/sql-store.ts';

const EOF = Buffer.from([0xfe, 0x00, 0x00, 0x00, 0x00]);

// A result set of one text column and one row, the way the server frames it:
// column count, column definition, EOF, row, EOF.
function resultSet(value: string): Buffer[] {
  return [
    Buffer.from([0x01]),
    Buffer.from([0x03, 0x64, 0x65, 0x66]),
    EOF,
    Buffer.from([Buffer.byteLength(value), ...Buffer.from(value, 'utf8')]),
    EOF,
  ];
}

async function store(): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'arcod-mysql-queue-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, SQL_STORE_SOURCE + '\nexport { SqlStore };\n', 'utf8');
  const { SqlStore } = await import(pathToFileURL(file).href);
  const item = new SqlStore('mysql://localhost:3306/arcod');
  const connection = item.connection;
  // Stand in for the socket and the wire: the fake answers by SQL text.
  connection.socket = { write: () => {} };
  connection.ready = true;
  item.schema = Promise.resolve();
  return { store: item, connection };
}

test('two concurrent statements do not interleave on one connection', async () => {
  const { connection } = await store();
  const packets: Record<string, Buffer[]> = {
    'SELECT a': resultSet('A'),
    'SELECT b': resultSet('B'),
  };
  const events: string[] = [];
  let current = '';
  let pending: Buffer[] = [];
  let pendingReads = 0;
  connection.writePacket = (payload: Buffer) => {
    const sql = payload.subarray(1).toString('utf8');
    if (pendingReads > 0) events.push('overlap:' + sql);
    events.push('write:' + sql);
    current = sql;
    pending = packets[sql].slice();
  };
  connection.readPacket = async () => {
    pendingReads += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    pendingReads -= 1;
    events.push('read:' + current);
    return pending.shift();
  };

  const [first, second] = await Promise.all([connection.run('SELECT a'), connection.run('SELECT b')]);
  assert.deepEqual(first.rows, [[Buffer.from('A')]], 'the first caller reads its own row');
  assert.deepEqual(second.rows, [[Buffer.from('B')]], 'the second caller reads its own row');
  assert.deepEqual(events.filter((event) => event.startsWith('overlap:')), [], 'no statement starts while another waits for rows');
  // Serialized, not just lucky: A is answered before B is even sent.
  assert.deepEqual(events, [
    'write:SELECT a', 'read:SELECT a', 'read:SELECT a', 'read:SELECT a', 'read:SELECT a', 'read:SELECT a',
    'write:SELECT b', 'read:SELECT b', 'read:SELECT b', 'read:SELECT b', 'read:SELECT b', 'read:SELECT b',
  ]);
});

test('a failed statement releases the queue for the next one', async () => {
  const { connection } = await store();
  let calls = 0;
  connection.writePacket = () => {};
  connection.readPacket = async () => {
    calls += 1;
    if (calls === 1) return Buffer.from([0xff, 0x10, 0x27, 0x23, 0x30, 0x30, 0x30]);
    return Buffer.from([0x00, 0x00]);
  };
  const failed = connection.run('SELECT broken');
  const next = connection.run('SELECT ok');
  await assert.rejects(failed, /mysql 10000/);
  const answer = await next;
  assert.equal(answer.affected, 0, 'the next statement still runs');
});
