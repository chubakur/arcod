// B92.1: an operation whose body returns bytes answers the bytes themselves,
// not JSON.stringify(Buffer) = {"type":"Buffer","data":[...]}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness.ts';

const spec = [
  'module files @0.1.0 {',
  '  meta {',
  '    owner: "@me"',
  '  }',
  '}',
  'use capability arcod.std.blob @1',
  'error NotFound',
  'error Invalid',
  'service Files : http {',
  '  uses files: blob',
  '  effects {',
  '    allow files.putBytes, files.getBytes',
  '    deny net, fs, exec',
  '  }',
  '  contract {',
  '    public op save(id: string, data: string) -> string {',
  '      route: "POST /v1/files"',
  '      errors: Invalid',
  '    }',
  '    public op download(id: string) -> bytes {',
  '      route: "GET /v1/files/:id"',
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

const bodies = {
  save: 'export async function save(input, io) {\n  await io.blobPutBytes(String(input.id), Buffer.from(String(input.data), "base64"));\n  return { result: String(input.id) };\n}',
  download: 'export async function download(input, io) {\n  const bytes = await io.blobGetBytes(String(input.id));\n  if (bytes === null) return { error: "NotFound" };\n  return { result: bytes };\n}',
};

test('a bytes result is answered as the file, not as JSON of a Buffer', async () => {
  const svc = await startService(spec, { impl: bodies });
  try {
    const payload = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);
    const saved = await fetch(svc.base + '/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'f', data: payload.toString('base64') }),
    });
    assert.equal(saved.status, 201, await saved.text());

    const response = await fetch(svc.base + '/v1/files/f');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/octet-stream/);
    const back = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...back], [...payload]);

    const missing = await fetch(svc.base + '/v1/files/nope');
    assert.equal(missing.status, 404);
  } finally {
    await svc.stop();
  }
});
