import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PG_STORE_SOURCE, PG_SQL_STORE_SOURCE } from '../src/emit/pg-store.ts';

// The Postgres client is emitted source, not an imported module: load it the
// way the generated service will see it, then drive it with a fake server.

test('postgres connect times out and closes the socket', async () => {
  const mod = await pg();
  const server = createServer(() => { /* accept, never answer */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const db = new mod.PgConnection('postgres://arcod:s3cret@127.0.0.1:' + port + '/arcod');
    await assert.rejects(() => db.connect(80), /connect timeout/);
  } finally { server.close(); }
});

// ---------- password auth ----------
function authBackend(ask: (socket: import('node:net').Socket) => void) {
  const seen: { password: string | null } = { password: null };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          ask(socket);
          continue;
        }
        if (tag === 'p') {
          seen.password = packet.toString('utf8').replace(String.fromCharCode(0), '');
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]));
        }
      }
    });
  });
  return { server, seen };
}

async function connectTo(port: number, mod: any) {
  const db = new mod.PgConnection('postgres://arcod:s3cret@127.0.0.1:' + port + '/arcod');
  await db.connect(2000);
  await db.end();
}

test('postgres cleartext and MD5 auth send the expected password message', async () => {
  const mod = await pg();
  const clear = authBackend((socket) => socket.write(message('R', int32(3))));
  await new Promise<void>((resolve) => clear.server.listen(0, '127.0.0.1', resolve));
  try {
    await connectTo((clear.server.address() as { port: number }).port, mod);
    assert.equal(clear.seen.password, 's3cret');
  } finally { clear.server.close(); }

  const salt = Buffer.from([1, 2, 3, 4]);
  const md5 = authBackend((socket) => socket.write(message('R', Buffer.concat([int32(5), salt]))));
  await new Promise<void>((resolve) => md5.server.listen(0, '127.0.0.1', resolve));
  try {
    await connectTo((md5.server.address() as { port: number }).port, mod);
    const inner = createHash('md5').update('s3cret' + 'arcod').digest('hex');
    const expected = 'md5' + createHash('md5').update(inner).update(salt).digest('hex');
    assert.equal(md5.seen.password, expected);
  } finally { md5.server.close(); }
});

let loaded: any = null;
async function pg() {
  if (loaded) return loaded;
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pg-'));
  const file = join(dir, 'pg.mjs');
  await writeFile(file, PG_STORE_SOURCE, 'utf8');
  loaded = await import(pathToFileURL(file).href);
  return loaded;
}

// ---------- fake backend ----------
function cstr(value: string): Buffer {
  return Buffer.concat([Buffer.from(String(value), 'utf8'), Buffer.from([0])]);
}
function message(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([head, payload]);
}
function int32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value, 0);
  return out;
}
function int16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeInt16BE(value, 0);
  return out;
}
function rowDescription(names: string[]): Buffer {
  const parts = [int16(names.length)];
  for (const name of names) parts.push(cstr(name), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0));
  return message('T', Buffer.concat(parts));
}
function dataRow(cells: Array<string | null>): Buffer {
  const parts = [int16(cells.length)];
  for (const cell of cells) {
    if (cell === null) parts.push(int32(-1));
    else parts.push(int32(Buffer.byteLength(cell)), Buffer.from(cell, 'utf8'));
  }
  return message('D', Buffer.concat(parts));
}
function errorResponse(code: string, text: string): Buffer {
  return message('E', Buffer.concat([
    Buffer.from('S'), cstr('ERROR'),
    Buffer.from('C'), cstr(code),
    Buffer.from('M'), cstr(text),
    Buffer.from([0]),
  ]));
}

test('postgres SCRAM-SHA-256 matches the RFC 7677 vector', async () => {
  const mod = await pg();
  const firstBare = 'n=user,r=rOprNGfwEbeRWgbNEkqO';
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  const out = mod.pgScramFinal('pencil', serverFirst, firstBare);
  assert.equal(
    out.clientFinal,
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ='
  );
  assert.equal(out.serverSignature, '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
});

test('postgres client starts up, queries and maps a unique violation', async () => {
  const mod = await pg();
  const seen = { startup: [] as string[], queries: [] as string[] };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'Q' || tag === 'X' || tag === 'p';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        // Startup packet: protocol version + null-terminated key/value pairs.
        if (!typed) {
          const parts = packet.subarray(4).toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
          seen.startup = parts;
          socket.write(Buffer.concat([
            message('R', int32(0)),
            message('S', Buffer.concat([cstr('server_version'), cstr('16.4')])),
            message('K', Buffer.concat([int32(1), int32(2)])),
            message('Z', Buffer.from('I')),
          ]));
          continue;
        }
        const type = tag;
        const body = packet;
        if (type === 'Q') {
          const sql = body.toString('utf8').replace(String.fromCharCode(0), '');
          seen.queries.push(sql);
          if (sql.includes('boom')) {
            socket.write(Buffer.concat([errorResponse('23505', 'duplicate key value violates unique constraint'), message('Z', Buffer.from('I'))]));
          } else {
            socket.write(Buffer.concat([
              rowDescription(['id', 'title']),
              dataRow(['42', 'hello']),
              message('C', cstr('SELECT 1')),
              message('Z', Buffer.from('I')),
            ]));
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const db = new mod.PgConnection('postgres://arcod:s3cret@127.0.0.1:' + port + '/arcod_test');
    await db.connect(2000);
    assert.deepEqual(seen.startup, ['user', 'arcod', 'database', 'arcod_test', 'client_encoding', 'UTF8']);
    const found = await db.query('SELECT id, title FROM tasks');
    assert.deepEqual(found.fields, ['id', 'title']);
    assert.deepEqual(found.rows, [['42', 'hello']]);
    await assert.rejects(() => db.query('INSERT boom'), (error: any) => {
      assert.equal(error.code, '23505');
      assert.equal(mod.pgIsUnique(error), true);
      return true;
    });
    await db.end();
  } finally {
    server.close();
  }
});

test('postgres literals and cells are typed, not string-concatenated', async () => {
  const mod = await pg();
  assert.equal(mod.pgLiteral('bytes', "a'b"), "decode('612762', 'hex')");
  assert.equal(mod.pgLiteral('string', "it's"), "'it''s'");
  assert.equal(mod.pgLiteral('bool', true), 'TRUE');
  assert.equal(mod.pgLiteral('json', { a: 1 }), "'{\"a\":1}'::jsonb");
  assert.equal(mod.pgLiteral('int', 7), '7');
  assert.equal(mod.pgLiteral('datetime', '2026-11-17T22:30:00Z'), "'2026-11-17 22:30:00'::timestamptz");
  assert.equal(mod.readPgCell('bool', 't'), true);
  assert.equal(mod.readPgCell('int', '12'), 12);
  assert.equal(mod.readPgCell('datetime', '2026-11-17 22:30:00+00'), '2026-11-17T22:30:00Z');
  assert.deepEqual(Object.keys(mod.readPgCell('json', '{"a":1}')), ['a']);
});

// ---------- PgStore over the same fake backend ----------
// The store, not just the client: entity SQL is quoting/literal-shaped for
// Postgres and the command tag is where claim/del get their affected count.

function storeBackend(seen: string[], sockets: Set<any> = new Set()) {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (tag !== 'Q') continue;
        const sql = packet.toString('utf8').replace(/\x00$/, '');
        seen.push(sql);
        if (/^SELECT checksum FROM arcod_migrations/.test(sql)) {
          socket.write(Buffer.concat([rowDescription(['checksum']), message('C', cstr('SELECT 0')), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (/^SELECT .* FROM "task"/.test(sql)) {
          socket.write(Buffer.concat([
            rowDescription(['id', 'done']),
            rowData(['t1', 't']),
            message('C', cstr('SELECT 1')),
            message('Z', Buffer.from('I')),
          ]));
          continue;
        }
        const command = /^INSERT/.test(sql) ? 'INSERT 0 1'
          : /^UPDATE/.test(sql) ? 'UPDATE 1'
          : /^DELETE/.test(sql) ? 'DELETE 1'
          : /^SELECT/.test(sql) ? 'SELECT 0'
          : 'OK';
        socket.write(Buffer.concat([message('C', cstr(command)), message('Z', Buffer.from('I'))]));
      }
    });
  });
  return server;
}

function rowData(values: string[]): Buffer {
  const parts = [int16(values.length)];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    parts.push(int32(bytes.length), bytes);
  }
  return message('D', Buffer.concat(parts));
}

let storeLoaded: any = null;
async function pgStore() {
  if (storeLoaded) return storeLoaded;
  const stubs = [
    'class ArcodError extends Error { constructor(name) { super(name); this.name = name; } }',
    'const MIGRATIONS = [];',
    'function parseOrder(order) { return Array.isArray(order) ? order : []; }',
    'function encodeCursor() { return null; }',
    'function decodeCursor() { return { v: [false], id: "a" }; }',
    '',
  ].join('\n');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pgstore-'));
  const file = join(dir, 'store.mjs');
  await writeFile(file, stubs + PG_STORE_SOURCE + '\n' + PG_SQL_STORE_SOURCE + '\nexport { PgStore };\n', 'utf8');
  storeLoaded = await import(pathToFileURL(file).href);
  return storeLoaded;
}

test('PgStore issues postgres SQL and reads the command tag for affected rows', async () => {
  const mod = await pgStore();
  const seen: string[] = [];
  const sockets = new Set<any>();
  const server = storeBackend(seen, sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let store: any = null;
  try {
    store = new mod.PgStore('postgres://arcod:arcod@127.0.0.1:' + port + '/arcod');
    await store.prepare();
    const columns = [
      { name: 'id', base: 'string' },
      { name: 'done', base: 'bool' },
    ];
    await store.entityInsert('task', columns, { id: 't1', done: true });
    assert.match(seen[seen.length - 1], /INSERT INTO "task" \("id", "done"\) VALUES \('t1', TRUE\)/);
    await store.entityInsert('task', [{ name: 'id', base: 'string' }, { name: 'title', base: 'string' }], { id: 'x', title: "O'Brien; DROP TABLE task" });
    assert.match(seen[seen.length - 1], /'O''Brien; DROP TABLE task'/);
    assert.equal(await store.claim('lock-1'), true);
    assert.match(seen[seen.length - 1], /ON CONFLICT \(k\) DO NOTHING/);
    assert.equal(await store.del('lock-1'), 1);
    await store.set('k', 'v', 1000);
    assert.match(seen[seen.length - 1], /ON CONFLICT \(k\) DO UPDATE SET v = EXCLUDED\.v/);
    assert.ok(seen.some((sql) => /CREATE TABLE IF NOT EXISTS arcod_migrations/.test(sql)));
    const updated = await store.entityUpdate('task', [{ name: 'id', base: 'string' }, { name: 'done', base: 'bool' }], 't1', { done: false });
    assert.equal(updated.done, false);
    // DELETE 1 from the command tag is the answer io.remove hands the client,
    // so a missing id reads false instead of a silent success.
    assert.equal(await store.entityRemove('task', [{ name: 'id', base: 'string' }], 't1'), 1);
    assert.match(seen[seen.length - 1], /DELETE FROM "task" WHERE "id" = 't1'/);
    await store.outboxAppend('e1', 'topic', 'payload');
    assert.match(seen[seen.length - 1], /INSERT INTO arcod_outbox \(id, topic, payload, created_at\)/);
    const pongs = await Promise.all([store.ping(), store.ping(), store.ping()]);
    assert.deepEqual(pongs, ['PONG', 'PONG', 'PONG']);
    await store.entityFind('task', [{ name: 'id', base: 'string' }, { name: 'done', base: 'bool' }], { limit: 2, order: [{ field: 'done', dir: 1 }], where: { done: true }, cursor: 'cur' });
    const page = seen[seen.length - 1];
    assert.match(page, /WHERE "done" = TRUE AND \(/);
    assert.match(page, /IS NOT DISTINCT FROM FALSE/);
    assert.match(page, /"id" > 'a'/);
    assert.match(page, /ORDER BY \("done" IS NULL\) ASC, "done" ASC, "id" ASC LIMIT 3/);
  } finally {
    try { if (store) await store.connection.end(); } catch (ignored) {}
    server.close();
    for (const socket of sockets) socket.destroy();
  }
});

// ---------- statement errors keep the connection (B90) ----------
// Postgres answers a failed statement with ErrorResponse followed by
// ReadyForQuery: the error belongs to one statement, not to the socket. The
// client used to destroy the only connection there, so every later query --
// including /healthz -> ping -- queued behind a dead socket forever.
test('a statement error rejects only its own query and the socket keeps serving', async () => {
  const mod = await pg();
  const seen: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (tag !== 'Q') continue;
        const sql = packet.toString('utf8').replace(String.fromCharCode(0), '');
        seen.push(sql);
        if (sql.includes('boom')) {
          socket.write(Buffer.concat([
            errorResponse('23505', 'duplicate key value violates unique constraint'),
            message('Z', Buffer.from('I')),
          ]));
          continue;
        }
        socket.write(Buffer.concat([
          rowDescription(['n']), dataRow(['1']), message('C', cstr('SELECT 1')), message('Z', Buffer.from('I')),
        ]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const db = new mod.PgConnection('postgres://arcod:s3cret@127.0.0.1:' + port + '/arcod');
    await db.connect(2000);
    await assert.rejects(() => db.query('INSERT boom'), (error: any) => {
      assert.equal(error.code, '23505');
      return true;
    });
    assert.equal(db.alive(), true);
    const found = await db.query('SELECT 1');
    assert.deepEqual(found.rows, [['1']]);
    assert.equal(seen.length, 2);
    await db.end();
  } finally {
    server.close();
  }
});

function errorBackend(options: { dropFirstSelect?: boolean; closeAfterFirstSelect?: boolean } = {}) {
  const seen: string[] = [];
  let connections = 0;
  let dropped = false;
  const server = createServer((socket) => {
    connections += 1;
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (tag !== 'Q') continue;
        const sql = packet.toString('utf8').replace(String.fromCharCode(0), '');
        seen.push(sql);
        if (/^SELECT checksum FROM arcod_migrations/.test(sql)) {
          socket.write(Buffer.concat([rowDescription(['checksum']), message('C', cstr('SELECT 0')), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (/^INSERT INTO "task"/.test(sql) && sql.includes("'dup'")) {
          socket.write(Buffer.concat([
            errorResponse('23505', 'duplicate key value violates unique constraint'),
            message('Z', Buffer.from('I')),
          ]));
          continue;
        }
        if (/^SELECT 1/.test(sql)) {
          if (options.dropFirstSelect && !dropped) {
            dropped = true;
            socket.destroy();
            continue;
          }
          socket.write(Buffer.concat([
            rowDescription(['?column?']), dataRow(['1']), message('C', cstr('SELECT 1')), message('Z', Buffer.from('I')),
          ]));
          // A graceful close after the answer: the service was idle, not
          // mid-statement, when the server went away.
          if (options.closeAfterFirstSelect && !dropped) {
            dropped = true;
            socket.end();
          }
          continue;
        }
        const command = /^INSERT/.test(sql) ? 'INSERT 0 1'
          : /^UPDATE/.test(sql) ? 'UPDATE 1'
          : /^DELETE/.test(sql) ? 'DELETE 1'
          : /^SELECT/.test(sql) ? 'SELECT 0'
          : 'OK';
        socket.write(Buffer.concat([message('C', cstr(command)), message('Z', Buffer.from('I'))]));
      }
    });
  });
  return { server, seen, connections: () => connections };
}

test('a duplicate insert answers Conflict and leaves the store usable (B90)', async () => {
  const mod = await pgStore();
  const backend = errorBackend();
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const port = (backend.server.address() as { port: number }).port;
  let store: any = null;
  try {
    store = new mod.PgStore('postgres://arcod:arcod@127.0.0.1:' + port + '/arcod');
    await store.prepare();
    const columns = [{ name: 'id', base: 'string' }];
    await assert.rejects(
      () => store.entityInsert('task', columns, { id: 'dup' }),
      (error: any) => { assert.equal(error.name, 'Conflict'); return true; }
    );
    // The error arrived with ReadyForQuery: the same socket answers the next
    // statements instead of queueing behind a destroyed connection.
    assert.equal(await store.ping(), 'PONG');
    await store.entityInsert('task', columns, { id: 'other' });
    assert.equal(backend.connections(), 1);
  } finally {
    try { if (store) await store.connection.end(); } catch (ignored) {}
    backend.server.close();
  }
});

// Postgres marks a transaction aborted after its first failing statement:
// every later statement fails 25P02 until ROLLBACK. The client has to treat
// that error like any other statement error, so a rolled-back transaction
// leaves the one socket usable -- that is the path PgStore.take()/takeIf()
// take in their catch, and it used to be the same socket a duplicate killed.
function transactionBackend() {
  const seen: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    let aborted = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const packet = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (tag !== 'Q') continue;
        const sql = packet.toString('utf8').replace(String.fromCharCode(0), '');
        seen.push(sql);
        if (sql === 'BEGIN') {
          aborted = false;
          socket.write(Buffer.concat([message('C', cstr('BEGIN')), message('Z', Buffer.from('T'))]));
          continue;
        }
        if (sql === 'ROLLBACK') {
          aborted = false;
          socket.write(Buffer.concat([message('C', cstr('ROLLBACK')), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (aborted) {
          socket.write(Buffer.concat([
            errorResponse('25P02', 'current transaction is aborted, commands ignored until end of transaction block'),
            message('Z', Buffer.from('E')),
          ]));
          continue;
        }
        if (sql.startsWith('INSERT')) {
          aborted = true;
          socket.write(Buffer.concat([
            errorResponse('23505', 'duplicate key value violates unique constraint'),
            message('Z', Buffer.from('E')),
          ]));
          continue;
        }
        socket.write(Buffer.concat([
          rowDescription(['?column?']), dataRow(['1']), message('C', cstr('SELECT 1')), message('Z', Buffer.from('I')),
        ]));
      }
    });
  });
  return { server, seen };
}

test('an aborted transaction fails loudly and ROLLBACK leaves the socket usable', async () => {
  const mod = await pg();
  const backend = transactionBackend();
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const port = (backend.server.address() as { port: number }).port;
  try {
    const db = new mod.PgConnection('postgres://arcod:s3cret@127.0.0.1:' + port + '/arcod');
    await db.connect(2000);
    await db.query('BEGIN');
    await assert.rejects(
      () => db.query("INSERT INTO task (id) VALUES ('dup')"),
      (error: any) => { assert.equal(error.code, '23505'); return true; }
    );
    // The transaction stays aborted on the server: the next statement fails
    // with 25P02 and that error must not close the connection either.
    await assert.rejects(
      () => db.query('SELECT 1'),
      (error: any) => { assert.equal(error.code, '25P02'); return true; }
    );
    assert.equal(db.alive(), true);
    await db.query('ROLLBACK');
    const found = await db.query('SELECT 1');
    assert.deepEqual(found.rows, [['1']]);
    assert.deepEqual(backend.seen.slice(-2), ['ROLLBACK', 'SELECT 1']);
    await db.end();
  } finally {
    backend.server.close();
  }
});

test('PgStore reconnects after the server closes the socket (B90)', async () => {
  const mod = await pgStore();
  const backend = errorBackend({ dropFirstSelect: true });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const port = (backend.server.address() as { port: number }).port;
  let store: any = null;
  try {
    store = new mod.PgStore('postgres://arcod:arcod@127.0.0.1:' + port + '/arcod');
    await store.prepare();
    await assert.rejects(() => store.ping(), /postgres connection closed/);
    assert.equal(await store.ping(), 'PONG');
    assert.equal(backend.connections(), 2);
    assert.equal(backend.seen.filter((sql) => /^CREATE TABLE IF NOT EXISTS arcod_migrations/.test(sql)).length, 1, 'migrations are not re-run');
  } finally {
    try { if (store) await store.connection.end(); } catch (ignored) {}
    backend.server.close();
  }
});

test('PgStore reconnects after the server closes an idle socket (B90)', async () => {
  const mod = await pgStore();
  const backend = errorBackend({ closeAfterFirstSelect: true });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const port = (backend.server.address() as { port: number }).port;
  let store: any = null;
  try {
    store = new mod.PgStore('postgres://arcod:arcod@127.0.0.1:' + port + '/arcod');
    await store.prepare();
    assert.equal(await store.ping(), 'PONG');
    // Nothing is in flight when the close arrives; the connection turns dead
    // and the next statement connects again instead of writing into it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(store.connection.alive(), false);
    assert.equal(await store.ping(), 'PONG');
    assert.equal(backend.connections(), 2);
    assert.equal(backend.seen.filter((sql) => /^CREATE TABLE IF NOT EXISTS arcod_migrations/.test(sql)).length, 1, 'migrations are not re-run');
  } finally {
    try { if (store) await store.connection.end(); } catch (ignored) {}
    backend.server.close();
  }
});
