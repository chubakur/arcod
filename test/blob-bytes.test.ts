import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { BLOB_SOURCE } from '../src/emit/blob.ts';
import { startService } from './harness.ts';

type Driver = {
  blobPut: (key: string, value: string, type?: string) => Promise<void>;
  blobGet: (key: string) => Promise<string | null>;
  blobPutBytes: (key: string, value: Uint8Array, type?: string) => Promise<void>;
  blobGetBytes: (key: string) => Promise<Buffer | null>;
  blobDelete: (key: string) => Promise<void>;
};

function loadDriver(env: Record<string, string>, fetchImpl: typeof fetch = fetch): Driver {
  const factory = new Function(
    'createHmac',
    'createHash',
    'fetch',
    'process',
    BLOB_SOURCE + '\nreturn { blobPut, blobGet, blobPutBytes, blobGetBytes, blobDelete };',
  ) as (...args: unknown[]) => Driver;
  return factory(createHmac, createHash, fetchImpl, { env });
}

const payload = Uint8Array.from([0x00, 0xff, 0x41, 0x80, 0x0a]);

test('memory driver round-trips bytes without UTF-8 or String()', async () => {
  const driver = loadDriver({ BLOB_DRIVER: 'memory' });
  await driver.blobPutBytes('bin', payload, 'application/octet-stream');
  const back = await driver.blobGetBytes('bin');
  assert.ok(back);
  assert.deepEqual([...back!], [...payload]);

  // The text pair does not see the binary entry and still round-trips text.
  assert.equal(await driver.blobGet('bin'), null);
  await driver.blobPut('text', 'héllo');
  assert.equal(await driver.blobGet('text'), 'héllo');
  assert.equal(await driver.blobGetBytes('text'), null);
});

test('S3 driver signs and stores the same bytes, and reads bytes back', async () => {
  const stored = new Map<string, Buffer>();
  const signed: Array<{ path: string; hash: string; body: Buffer }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'PUT') {
        signed.push({ path, hash: String(req.headers['x-amz-content-sha256'] ?? ''), body });
        if (path !== '/files') stored.set(path, body);
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET') {
        const value = stored.get(path);
        if (!value) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200).end(value);
        return;
      }
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    S3_ENDPOINT: 'http://127.0.0.1:' + address.port,
    S3_BUCKET: 'files',
    S3_ACCESS_KEY: 'minio',
    S3_SECRET_KEY: 'minio123',
    S3_REGION: 'us-east-1',
  };
  try {
    const driver = loadDriver(env);
    await driver.blobPutBytes('bin', payload, 'application/octet-stream');
    const object = signed.find((item) => item.path === '/files/bin');
    assert.ok(object, 'the object PUT reached S3');
    assert.deepEqual(object!.body, Buffer.from(payload));
    assert.equal(object!.hash, createHash('sha256').update(Buffer.from(payload)).digest('hex'));
    assert.notEqual(object!.hash, createHash('sha256').update(String(payload)).digest('hex'));

    const back = await driver.blobGetBytes('bin');
    assert.ok(back);
    assert.deepEqual([...back!], [...payload]);

    // The string path is unchanged: a text body still travels as UTF-8 text.
    await driver.blobPut('hello', 'привет');
    const text = signed.find((item) => item.path === '/files/hello');
    assert.ok(text);
    assert.equal(text!.body.toString('utf8'), 'привет');
    assert.equal(await driver.blobGet('hello'), 'привет');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const binSpec = [
  'module binfile @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'use capability arcod.std.blob @1',
  'error NotFound',
  'error Invalid',
  'service Bin : http {',
  '  uses files: blob',
  '  effects {',
  '    allow files.putBytes, files.getBytes',
  '    deny net, fs, exec',
  '  }',
  '  contract {',
  '    public op save(id: string, data: string) -> string {',
  '      route: "POST /v1/bin"',
  '      errors: Invalid',
  '    }',
  '    public op load(id: string) -> string {',
  '      route: "GET /v1/bin/:id"',
  '      errors: NotFound',
  '    }',
  '  }',
  '}',
  'environment dev {',
  '  bind files -> s3(host: "s3", port: 9000)',
  '  deploy docker',
  '}',
  '',
].join('\n');

const binBodies = {
  save: 'export async function save(input, io) {\n  await io.blobPutBytes(String(input.id), Buffer.from(String(input.data), "base64"), "application/octet-stream");\n  return { result: String(input.id) };\n}',
  load: 'export async function load(input, io) {\n  const bytes = await io.blobGetBytes(String(input.id));\n  if (bytes === null) return { error: "NotFound" };\n  return { result: Buffer.from(bytes).toString("base64") };\n}',
};

test('a service body reaches io.blobPutBytes/io.blobGetBytes (B79)', async () => {
  const svc = await startService(binSpec, { impl: binBodies });
  try {
    const payload = Buffer.from([0x00, 0xff, 0x41, 0x80]);
    const saved = await fetch(svc.base + '/v1/bin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bin', data: payload.toString('base64') }),
    });
    assert.equal(saved.status, 201, await saved.text());
    const loaded = await fetch(svc.base + '/v1/bin/bin');
    assert.equal(loaded.status, 200);
    assert.equal(await loaded.text(), payload.toString('base64'));
  } finally {
    await svc.stop();
  }
});
