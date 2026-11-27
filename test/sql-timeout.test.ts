// B99: a MySQL server that accepts the socket and then says nothing used to pin
// the request, /healthz and the whole service forever. Connect/handshake and
// every query now share ARCod_SQL_TIMEOUT_MS (falling back to
// ARCod_STORE_TIMEOUT_MS); on expiry the socket is dropped so a late reply
// cannot be read as the next statement's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { SQL_STORE_SOURCE } from '../src/emit/sql-store.ts';

type Connection = {
  ensure: () => Promise<void>;
  run: (sql: string) => Promise<unknown>;
  ready: boolean;
};

function loadConnection(timeoutMs: number): { make: (url: string) => Connection } {
  const factory = new Function(
    'net',
    'createHash',
    'createPublicKey',
    'publicEncrypt',
    'constants',
    'MIGRATIONS',
    'process',
    SQL_STORE_SOURCE + '\nreturn { MySqlConnection };',
  ) as (...args: unknown[]) => { MySqlConnection: new (url: string) => Connection };
  const env = { ARCod_SQL_TIMEOUT_MS: String(timeoutMs) };
  const { MySqlConnection } = factory(net, createHash, createPublicKey, publicEncrypt, constants, [], { env });
  return { make: (url) => new MySqlConnection(url) };
}

function packet(payload: Buffer, seq = 0): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = seq;
  return Buffer.concat([header, payload]);
}

// A minimal handshake: protocol 10, a version, salt, capability flags with
// CLIENT_PLUGIN_AUTH, and a plugin name. The client answers with its auth
// packet; the server accepts it with OK and then stops talking.
function greeting(): Buffer {
  const salt1 = Buffer.from('12345678', 'utf8');
  const salt2 = Buffer.from('abcdefghijkl', 'utf8');
  const parts = [
    Buffer.from([0x0a]),
    Buffer.from('5.7.0\0', 'utf8'),
    Buffer.from([1, 0, 0, 0]),
    salt1,
    Buffer.from([0]),
    Buffer.from([0xff, 0xff]),
    Buffer.from([0x21]),
    Buffer.from([0x02, 0x00]),
    Buffer.from([0xff, 0xff]),
    Buffer.from([21]),
    Buffer.alloc(10),
    salt2,
    Buffer.from([0]),
    Buffer.from('mysql_native_password\0', 'utf8'),
  ];
  return packet(Buffer.concat(parts), 0);
}

test('a silent MySQL server times out on connect/handshake', async () => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    // Accepts the connection and says nothing: connect() resolves, the greeting never arrives.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { make } = loadConnection(80);
  const connection = make('mysql://root@127.0.0.1:' + address.port + '/app');
  try {
    const started = Date.now();
    await assert.rejects(connection.ensure(), /mysql: connect timeout/);
    assert.ok(Date.now() - started < 2000, 'the deadline fired');
    assert.equal(connection.ready, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a server that goes silent after auth times out the query and drops the socket', async () => {
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on('error', () => {});
    socket.write(greeting());
    socket.once('data', () => {
      socket.write(packet(Buffer.from([0x00]), 2));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { make } = loadConnection(80);
  const connection = make('mysql://root@127.0.0.1:' + address.port + '/app');
  try {
    await connection.ensure();
    assert.equal(connection.ready, true);
    const started = Date.now();
    await assert.rejects(connection.run('SELECT 1'), /mysql: query timeout/);
    assert.ok(Date.now() - started < 2000, 'the deadline fired');
    assert.equal(connection.ready, false, 'the broken connection is not reused');
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
