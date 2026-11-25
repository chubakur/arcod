import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serve } from '../src/lsp-server.ts';

// The editor wire format is where a language server breaks quietly: an editor
// writes a frame in whatever chunks the pipe gives it, and a request that is
// dropped looks like "the plugin does nothing". test/lsp-server.test.ts drives
// a child process, so this code was never measured; serve() takes streams now
// and these cases run the same loop in-process.

interface Frame {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

function frame(payload: unknown): string {
  const body = JSON.stringify(payload);
  return 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function session(): Promise<{
  send: (text: string) => Promise<void>;
  input: PassThrough;
  frames: Frame[];
}> {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const header = buffer.slice(0, end);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(match, 'every answer carries Content-Length: ' + header);
      const start = end + 4;
      const length = Number(match![1]);
      if (buffer.length < start + length) return;
      frames.push(JSON.parse(buffer.slice(start, start + length)) as Frame);
      buffer = buffer.slice(start + length);
    }
  });
  serve({ input, output });
  return {
    input,
    frames,
    send: async (text: string) => {
      input.write(text);
      await tick();
      await tick();
    },
  };
}

const GOOD = [
  'module demo @0.1.0 {',
  '}',
  '',
  'service Ping : http {',
  '  contract {',
  '    public op ping() -> string {',
  '      route: "GET /v1/ping"',
  '    }',
  '  }',
  '}',
].join(String.fromCharCode(10));

test('a frame split across two chunks is answered once', async () => {
  const s = await session();
  const message = frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  s.input.write(message.slice(0, 17));
  await tick();
  assert.equal(s.frames.length, 0, 'a partial frame is not guessed at');
  s.input.write(message.slice(17));
  await tick();
  await tick();
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, 1);
  assert.equal(s.frames[0].result.serverInfo.name, 'arcod');
});

test('a header without Content-Length is skipped, not fatal', async () => {
  const s = await session();
  await s.send('X-Ignored: 1\r\n\r\n');
  assert.equal(s.frames.length, 0);
  await s.send(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }));
  assert.equal(s.frames.length, 1, 'the server still answers the next message');
  assert.equal(s.frames[0].id, 2);
  assert.equal(s.frames[0].result, null);
});

test('malformed JSON answers -32700 and the server keeps going', async () => {
  const s = await session();
  const broken = '{not json';
  await s.send('Content-Length: ' + broken.length + '\r\n\r\n' + broken);
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, null);
  assert.equal(s.frames[0].error.code, -32700);

  await s.send(frame({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }));
  assert.equal(s.frames.length, 2, 'a broken message does not close the loop');
  assert.equal(s.frames[1].id, 3);
});

// Valid JSON that is not a request used to be indistinguishable from a parse
// error (-32700) or, without a method, from an unsupported one (null). The
// three JSON-RPC refusals are separate promises and a client cannot tell them
// apart if the server collapses them.
test('a body that is not a request answers -32600, not -32700 and not silence', async () => {
  const s = await session();

  await s.send(frame(null));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, null, 'no id can be read, so the error carries null');
  assert.equal(s.frames[0].error.code, -32600);

  await s.send(frame({ jsonrpc: '2.0', id: 9 }));
  assert.equal(s.frames.length, 2);
  assert.equal(s.frames[1].id, 9, 'the id is readable even though the method is not');
  assert.equal(s.frames[1].error.code, -32600);

  await s.send(frame([{ jsonrpc: '2.0', method: 'shutdown' }]));
  assert.equal(s.frames.length, 3);
  assert.equal(s.frames[2].error.code, -32600, 'a batch is not a request this server accepts');

  await s.send(frame({ jsonrpc: '2.0', id: 10, method: 'shutdown' }));
  assert.equal(s.frames.length, 4, 'the server is still serving');
  assert.equal(s.frames[3].id, 10);
});

test('an unknown notification is silent, an unknown request answers -32601', async () => {
  const s = await session();

  await s.send(frame({ jsonrpc: '2.0', method: 'workspace/unknownThing' }));
  assert.equal(s.frames.length, 0, 'a notification has no id to answer to');

  await s.send(frame({ jsonrpc: '2.0', id: 12, method: 'workspace/unknownThing' }));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, 12);
  assert.equal(s.frames[0].error.code, -32601);
  assert.match(s.frames[0].error.message, /workspace\/unknownThing/);
  assert.equal(s.frames[0].result, undefined, 'a refusal must not look like an empty result');
});

// A notification has no id, so JSON-RPC forbids answering it. Every request
// handler passes `msg.id`, so a request method sent as a notification used to
// write an id-less result: a frame the client cannot match to anything.
// Params a handler cannot read are a refusal, not a crash. A request gets
// -32602 with its id; a notification has no id, so it stays silent; the server
// keeps serving either way.
test('unreadable params are -32602 for a request and silence for a notification', async () => {
  const s = await session();

  await s.send(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen' }));
  assert.equal(s.frames.length, 0, 'a broken notification gets no answer');

  await s.send(frame({ jsonrpc: '2.0', id: 40, method: 'textDocument/hover' }));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, 40);
  assert.equal(s.frames[0].error.code, -32602);

  await s.send(frame({ jsonrpc: '2.0', id: 41, method: 'initialize', params: {} }));
  assert.equal(s.frames.length, 2, 'the server is still serving');
  assert.equal(s.frames[1].result.serverInfo.name, 'arcod');
});

test('a request method sent as a notification is not answered', async () => {
  const s = await session();
  await s.send(frame({ jsonrpc: '2.0', method: 'initialize', params: {} }));
  await s.send(frame({
    jsonrpc: '2.0',
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///tmp/arcod-no-id.arc' }, position: { line: 0, character: 0 } },
  }));
  await s.send(frame({ jsonrpc: '2.0', method: 'shutdown' }));
  assert.equal(s.frames.length, 0, 'a notification has no id, so it has no answer');

  // The id-less shutdown did not start shutdown mode either.
  await s.send(frame({ jsonrpc: '2.0', id: 30, method: 'initialize', params: {} }));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].id, 30);
  assert.equal(s.frames[0].result.serverInfo.name, 'arcod');
});

// `shutdown` is a promise: after it the server serves only `exit`. Without
// this, a client that keeps talking after shutdown gets answers from a session
// it has already declared over, and the exit code cannot say whether the
// shutdown ever happened.
test('after shutdown only exit is served; other messages are refused', async () => {
  const s = await session();
  await s.send(frame({ jsonrpc: '2.0', id: 20, method: 'initialize', params: {} }));
  assert.equal(s.frames.length, 1);

  await s.send(frame({ jsonrpc: '2.0', id: 21, method: 'shutdown' }));
  assert.equal(s.frames.length, 2);
  assert.equal(s.frames[1].result, null);

  await s.send(frame({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///tmp/arcod-after-shutdown.arc', languageId: 'arcod', version: 1, text: GOOD } },
  }));
  assert.equal(s.frames.length, 2, 'a notification after shutdown is not processed');

  await s.send(frame({
    jsonrpc: '2.0',
    id: 22,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///tmp/arcod-after-shutdown.arc' }, position: { line: 0, character: 0 } },
  }));
  assert.equal(s.frames.length, 3);
  assert.equal(s.frames[2].id, 22);
  assert.equal(s.frames[2].error.code, -32600);
  assert.match(s.frames[2].error.message, /shutting down/);
});

test('a percent-encoded uri names the document for diagnostics and formatting', async () => {
  const s = await session();
  const uri = 'file:///tmp/arcod%20lsp/demo.arc';
  await s.send(frame({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'arcod', version: 1, text: GOOD } },
  }));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].method, 'textDocument/publishDiagnostics');
  assert.equal(s.frames[0].params.uri, uri);
  assert.equal(
    s.frames[0].params.diagnostics.some((d: { severity: number }) => d.severity === 1),
    false,
    'a clean spec has no errors: ' + JSON.stringify(s.frames[0].params.diagnostics),
  );

  await s.send(frame({
    jsonrpc: '2.0',
    id: 4,
    method: 'textDocument/formatting',
    params: { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
  }));
  const answer = s.frames[1];
  assert.equal(answer.id, 4);
  assert.equal(Array.isArray(answer.result), true, 'formatting answers edits: ' + JSON.stringify(answer));

  await s.send(frame({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }));
});

test('a uri with a broken escape still gets diagnostics', async () => {
  const s = await session();
  const uri = 'file:///tmp/arcod%E0%A4%A/demo.arc';
  await s.send(frame({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'arcod', version: 1, text: GOOD } },
  }));
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].method, 'textDocument/publishDiagnostics');
  assert.equal(
    s.frames[0].params.diagnostics.some((d: { severity: number }) => d.severity === 1),
    false,
    'the file name is not a parse error: ' + JSON.stringify(s.frames[0].params.diagnostics),
  );
});
