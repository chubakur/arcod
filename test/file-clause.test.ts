// B92.2: an operation that answers a file says so in the contract —
// `file: "text/csv", "report.csv"` — and the runtime sends the stored bytes with
// exactly that content type and download name. Without the clause the same
// operation keeps the JSON/text answer it had; a declared file never gains a
// JSON wrapper, and 1 MB of CSV with quotes and CRLF comes back byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { startService } from './harness.ts';

const spec = [
  'module fileclause @0.1.0 {',
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
  '    public op save(id: string) -> string {',
  '      route: "POST /v1/save"',
  '      errors: Invalid',
  '    }',
  '    public op report(id: string) -> bytes {',
  '      route: "GET /v1/report/:id"',
  '      file: "text/csv", "report.csv"',
  '      errors: NotFound',
  '    }',
  '    public op note(id: string) -> string {',
  '      route: "GET /v1/note/:id"',
  '      file: "text/plain", "note.txt"',
  '      errors: NotFound',
  '    }',
  '    public op plain(id: string) -> bytes {',
  '      route: "GET /v1/plain/:id"',
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

// 1 MB of CSV: quoted commas, embedded quotes and CRLF line ends, the shape a
// JSON string had to escape and the client had to unescape.
const CSV = (() => {
  const lines = ['id,name,note'];
  for (let i = 0; lines.length < 20000; i += 1) lines.push(i + ',"name, ' + i + '","he said ""hi"" ' + i + '"');
  const text = lines.join('\r\n') + '\r\n';
  return Buffer.from(text, 'utf8');
})();

const bodies = {
  save: 'export async function save(input, io) {\n' +
    '  await io.blobPutBytes(String(input.id), Buffer.from(' + JSON.stringify(CSV.toString('base64')) + ', "base64"));\n' +
    '  return { result: String(input.id) };\n' +
    '}',
  report: 'export async function report(input, io) {\n' +
    '  const bytes = await io.blobGetBytes(String(input.id));\n' +
    '  if (bytes === null) return { error: "NotFound" };\n' +
    '  return { result: bytes };\n' +
    '}',
  note: 'export async function note(input, io) {\n' +
    '  if (String(input.id) !== "n") return { error: "NotFound" };\n' +
    '  return { result: "line one\\r\\nline two" };\n' +
    '}',
  plain: 'export async function plain(input, io) {\n' +
    '  const bytes = await io.blobGetBytes(String(input.id));\n' +
    '  if (bytes === null) return { error: "NotFound" };\n' +
    '  return { result: bytes };\n' +
    '}',
};

test('a file response is the stored bytes with the declared type and name', async () => {
  const svc = await startService(spec, { impl: bodies });
  try {
    const saved = await fetch(svc.base + '/v1/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r' }),
    });
    assert.equal(saved.status, 201, await saved.text());

    const response = await fetch(svc.base + '/v1/report/r');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.csv"');
    const back = Buffer.from(await response.arrayBuffer());
    assert.equal(back.length, CSV.length, 'the whole file is sent');
    assert.deepEqual([...back.slice(0, 64)], [...CSV.subarray(0, 64)]);
    assert.ok(back.equals(CSV), '1 MB CSV comes back byte for byte');

    const missing = await fetch(svc.base + '/v1/report/nope');
    assert.equal(missing.status, 404, 'a declared error keeps its status and JSON body');
    assert.match(missing.headers.get('content-type') || '', /application\/json/);
  } finally {
    await svc.stop();
  }
});

test('a text body under a file clause is the file too, and a plain bytes op is unchanged', async () => {
  const svc = await startService(spec, { impl: bodies });
  try {
    const note = await fetch(svc.base + '/v1/note/n');
    assert.equal(note.status, 200);
    assert.equal(note.headers.get('content-type'), 'text/plain');
    assert.equal(note.headers.get('content-disposition'), 'attachment; filename="note.txt"');
    assert.equal(await note.text(), 'line one\r\nline two');

    const saved = await fetch(svc.base + '/v1/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p' }),
    });
    assert.equal(saved.status, 201, await saved.text());
    const plain = await fetch(svc.base + '/v1/plain/p');
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get('content-type') || '', /application\/octet-stream/);
    assert.equal(plain.headers.get('content-disposition'), null, 'no file clause, no download name');
    const back = Buffer.from(await plain.arrayBuffer());
    assert.ok(back.equals(CSV));
  } finally {
    await svc.stop();
  }
});

test('OpenAPI publishes the declared media type and the download name', () => {
  const mod = parse(spec, 'main.arc');
  const doc = emitOpenapi(mod) as unknown as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }>; headers?: Record<string, unknown> }> }>>;
  };
  const get = doc.paths['/v1/report/{id}'].get;
  const ok = get.responses['200'];
  assert.ok(ok.content && ok.content['text/csv'], 'the declared type is the schema key');
  assert.equal(ok.content!['text/csv']!.schema!.format, 'binary');
  assert.ok(ok.headers && ok.headers['content-disposition'], 'the download name is documented');
  const plainGet = doc.paths['/v1/plain/{id}'].get;
  const plainOk = plainGet.responses['200'];
  assert.ok(plainOk.content && plainOk.content['application/octet-stream'] === undefined, 'a bytes op without the clause keeps its old schema');
});

test('the file clause needs a media type and a name', () => {
  const base = spec.split('\n');
  const withoutName = base.map((line) => (line.trim() === 'file: "text/csv", "report.csv"' ? '      file: "text/csv"' : line)).join('\n');
  assert.throws(() => parse(withoutName, 'main.arc'), (error: unknown) => error instanceof ParseError && /names the download file/.test(error.message));
  const badType = base.map((line) => (line.trim() === 'file: "text/csv", "report.csv"' ? '      file: "csv", "report.csv"' : line)).join('\n');
  assert.throws(() => parse(badType, 'main.arc'), (error: unknown) => error instanceof ParseError && /media type must look like/.test(error.message));
});
