import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PG_STORE_SOURCE } from '../src/emit/pg-store.ts';

// The SCRAM client must send the gs2 header ('n,,') in SASLInitialResponse.
// Postgres parses that packet as <gs2-header><client-first-bare>: the first
// character is the channel-binding flag, followed by a comma. Sending the bare
// message alone ('n=,r=...') makes the server answer
// 08P01 'malformed SCRAM message' and the service can never log in.

let loaded: any = null;
async function pg() {
  if (loaded) return loaded;
  const dir = await mkdtemp(join(tmpdir(), 'arcod-pg-scram-'));
  const file = join(dir, 'pg.mjs');
  await writeFile(file, PG_STORE_SOURCE, 'utf8');
  loaded = await import(pathToFileURL(file).href);
  return loaded;
}

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
function attr(list: string, name: string): string {
  for (const part of list.split(',')) {
    if (part.startsWith(name + '=')) return part.slice(name.length + 1);
  }
  return '';
}

// Computes the server signature the way postgres does, from the bare message
// the client actually sent. If the client signs a different auth message the
// final check fails, which is exactly the regression we want to catch.
function serverSignature(password: string, bare: string, serverFirst: string, saltB64: string, iterations: number) {
  const salt = Buffer.from(saltB64, 'base64');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = 'c=biws,r=' + attr(serverFirst, 'r');
  return createHmac('sha256', serverKey).update(bare + ',' + serverFirst + ',' + withoutProof).digest('base64');
}

test('postgres SCRAM-SHA-256 sends the gs2 header and authenticates', async () => {
  const mod = await pg();
  const password = 'pencil';
  const saltB64 = 'W22ZaJ0SNY7soEsUEjb6gQ==';
  const iterations = 4096;
  const seen: { initial?: string; clientFinal?: string; failure?: string; serverFirst?: string; serverSignature?: string } = {};

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    let step = 0;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 5) {
        const tag = String.fromCharCode(buffer[0]);
        const typed = tag === 'p' || tag === 'Q' || tag === 'X';
        const length = buffer.readInt32BE(typed ? 1 : 0);
        const total = typed ? length + 1 : length;
        if (buffer.length < total) return;
        const raw = buffer.subarray(typed ? 5 : 4, total);
        buffer = buffer.subarray(total);
        if (!started) {
          started = true;
          const mechanisms = Buffer.concat([cstr('SCRAM-SHA-256'), Buffer.from([0])]);
          socket.write(message('R', Buffer.concat([int32(10), mechanisms])));
          continue;
        }
        if (tag !== 'p') continue;
        const zero = raw.indexOf(0);
        const mechanism = raw.subarray(0, zero).toString('utf8');
        if (step === 0) {
          // SASLInitialResponse: mechanism \0 int32 length payload
          const len = raw.readInt32BE(zero + 1);
          const payload = raw.subarray(zero + 5, zero + 5 + len).toString('utf8');
          seen.initial = payload;
          if (mechanism !== 'SCRAM-SHA-256') seen.failure = 'mechanism ' + mechanism;
          if (!payload.startsWith('n,,')) seen.failure = 'missing gs2 header in ' + payload;
          const bare = payload.slice(3);
          const clientNonce = attr(bare, 'r');
          if (!clientNonce) seen.failure = 'no client nonce in ' + bare;
          const serverFirst = 'r=' + clientNonce + 'srvnonce0123456789,s=' + saltB64 + ',i=' + iterations;
          seen.serverFirst = serverFirst;
          seen.serverSignature = serverSignature(password, bare, serverFirst, saltB64, iterations);
          step = 1;
          socket.write(message('R', Buffer.concat([int32(11), Buffer.from(serverFirst, 'utf8')])));
          continue;
        }
        // client-final: c=biws,r=<nonce>,p=<proof>
        const final = raw.toString('utf8');
        seen.clientFinal = final;
        if (!final.includes('c=biws')) seen.failure = 'client-final without c=biws: ' + final;
        socket.write(message('R', Buffer.concat([int32(12), Buffer.from('v=' + seen.serverSignature, 'utf8')])));
        socket.write(message('R', int32(0)));
        socket.write(Buffer.concat([message('S', Buffer.concat([cstr('server_version'), cstr('16.4')])), message('Z', Buffer.from('I'))]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const db = new mod.PgConnection('postgres://arcod:' + password + '@127.0.0.1:' + port + '/arcod');
    await db.connect(2000);
    await db.end();
    assert.equal(seen.failure, undefined, 'fake server rejected the handshake');
    assert.match(seen.initial || '', /^n,,n=,r=.+/);
    // The bare part after the gs2 header is the nonce the client chose.
    assert.equal(attr((seen.initial || '').slice(3), 'r').length, 24);
    assert.match(seen.clientFinal || '', /^c=biws,r=[^,]+,p=.+$/);
    assert.ok((seen.clientFinal || '').includes(attr((seen.initial || '').slice(3), 'r')), 'client-final nonce must extend the client nonce');
  } finally {
    server.close();
  }
});

test('postgres SCRAM rejects a malformed bare message regression', async () => {
  // Guards the shape, not just the happy path: the first SASL payload must not
  // begin with 'n=' (the old bug), which no server can parse.
  const mod = await pg();
  assert.equal(typeof mod.PgConnection, 'function');
  assert.match(PG_STORE_SOURCE, /'n,,' \+ this\.clientFirstBare/);
  assert.equal(PG_STORE_SOURCE.includes("Buffer.from(this.clientFirstBare, 'utf8')"), false);
});
