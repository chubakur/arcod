import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `arcod lsp` is what every editor talks to, and nothing tested it: a broken
// Content-Length frame or a swallowed request would look like "the plugin does
// nothing". This suite speaks the wire protocol to a real child process.

const root = fileURLToPath(new URL('..', import.meta.url));
const URI = 'file:///tmp/arcod-lsp/demo.arc';

const GOOD = `module demo @0.1.0 {
  meta { owner: "@you" }
}

service Ping : http {
  contract {
    public op ping() -> string {
      route: "GET /v1/ping"
      post: result == "pong"
    }
  }
}
`;

const BROKEN = `module demo @0.1.0 {
  service Ping : http {
    contract {
      public op ping() -> string {
        route: "GET /v1/ping"
`;

interface Frame {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class Client {
  child: ChildProcessWithoutNullStreams;
  buffer: Buffer = Buffer.alloc(0);
  frames: Frame[] = [];
  waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  exit: Promise<number | null>;

  constructor() {
    this.child = spawn(process.execPath, ['bin/arcod.mjs', 'lsp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
    this.child.stdout.on('data', (chunk: Buffer) => this.feed(chunk));
    this.child.stdin.on('error', () => {});
  }

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      assert.ok(match, 'a header carries Content-Length: ' + header);
      const length = Number(match![1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      const frame = JSON.parse(body) as Frame;
      const waiter = this.waiters.findIndex((item) => item.match(frame));
      if (waiter >= 0) {
        const [pending] = this.waiters.splice(waiter, 1);
        pending.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    }
  }

  send(payload: object): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...payload });
    this.child.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  }

  waitFor(match: (f: Frame) => boolean, what: string): Promise<Frame> {
    const seen = this.frames.findIndex(match);
    if (seen >= 0) return Promise.resolve(this.frames.splice(seen, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + what)), 8000);
      this.waiters.push({
        match,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      });
    });
  }

  request(id: number, method: string, params?: unknown): Promise<Frame> {
    this.send({ id, method, params });
    return this.waitFor((f) => f.id === id, method + ' #' + id);
  }

  async stop(): Promise<void> {
    this.child.kill();
    await this.exit;
  }
}

test('the LSP server answers initialize, edits and shutdown over stdio', async () => {
  const client = new Client();
  try {
    const init = await client.request(1, 'initialize', { processId: process.pid, rootUri: null, capabilities: {} });
    assert.equal(init.error, undefined);
    assert.equal(init.result.serverInfo.name, 'arcod');
    const caps = init.result.capabilities;
    assert.equal(caps.hoverProvider, true);
    assert.equal(caps.definitionProvider, true);
    assert.equal(caps.documentSymbolProvider, true);
    assert.equal(caps.documentFormattingProvider, true);
    assert.deepEqual(caps.textDocumentSync, { openClose: true, change: 1 });

    client.send({ method: 'initialized', params: {} });

    // A clean document produces a diagnostics notification with nothing in it.
    client.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, languageId: 'arcod', version: 1, text: GOOD } } });
    const clean = await client.waitFor((f) => f.method === 'textDocument/publishDiagnostics' && f.params?.uri === URI, 'clean diagnostics');
    // A warning is fine (the example may lack rules); an error is not.
    assert.deepEqual(clean.params.diagnostics.filter((d: any) => d.severity === 1), []);

    const symbols = await client.request(2, 'textDocument/documentSymbol', { textDocument: { uri: URI } });
    assert.ok(Array.isArray(symbols.result));
    assert.ok(symbols.result.length > 0, 'a module with a service yields symbols');

    const hover = await client.request(3, 'textDocument/hover', { textDocument: { uri: URI }, position: { line: 6, character: 14 } });
    assert.equal(hover.error, undefined);

    const completion = await client.request(4, 'textDocument/completion', { textDocument: { uri: URI }, position: { line: 6, character: 4 } });
    assert.ok(Array.isArray(completion.result));

    const definitions = await client.request(5, 'textDocument/definition', { textDocument: { uri: URI }, position: { line: 6, character: 14 } });
    assert.equal(definitions.error, undefined);

    const refs = await client.request(6, 'textDocument/references', { textDocument: { uri: URI }, position: { line: 6, character: 14 }, context: { includeDeclaration: true } });
    assert.ok(Array.isArray(refs.result));

    const edits = await client.request(7, 'textDocument/formatting', { textDocument: { uri: URI }, options: { tabSize: 2, insertSpaces: true } });
    assert.equal(edits.error, undefined);

    // An unknown request is answered with null, not silence: a client that
    // waits forever looks like a hung editor.
    const unknown = await client.request(8, 'workspace/unknownThing', {});
    assert.equal(unknown.result, null);

    // Editing to a broken spec republishes diagnostics with an error code.
    client.send({ method: 'textDocument/didChange', params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: BROKEN }] } });
    const broken = await client.waitFor(
      (f) => f.method === 'textDocument/publishDiagnostics' && f.params?.uri === URI && f.params.diagnostics.some((d: any) => d.severity === 1),
      'an error diagnostic after the edit',
    );
    const error = broken.params.diagnostics.find((d: any) => d.severity === 1);
    assert.ok(error.message.length > 0);
    assert.equal(error.source, 'arcod');

    // Closing the document forgets it: a hover for the closed URI has no text.
    client.send({ method: 'textDocument/didClose', params: { textDocument: { uri: URI } } });
    const afterClose = await client.request(9, 'textDocument/hover', { textDocument: { uri: URI }, position: { line: 6, character: 14 } });
    assert.equal(afterClose.result, null);

    const shutdown = await client.request(10, 'shutdown');
    assert.equal(shutdown.result, null);
    client.send({ method: 'exit' });
    assert.equal(await client.exit, 0, 'exit ends the process cleanly');
  } finally {
    await client.stop();
  }
});
