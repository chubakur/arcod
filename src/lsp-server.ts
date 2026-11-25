// A zero-dependency Language Server Protocol server over stdio (JSON-RPC).
// It wraps src/lsp.ts, so the server speaks the same language as the compiler.
// Editors (VS Code, Neovim, JetBrains, ...) point their LSP client at
// 'arcod lsp' (or 'node bin/arcod-lsp.mjs').

import {
  completions, definition, diagnostics, documentSymbols, formatting, hover,
  references, type LspDiagnostic,
} from './lsp.ts';

interface Message { jsonrpc: string; id?: number | string | null; method?: string; params?: any; }

const documents = new Map<string, string>();

// LSP: `shutdown` is a promise that nothing else is served, and `exit`
// chooses its code from whether that promise was kept — 0 after a shutdown,
// 1 when the client tears the server down without asking. An editor that sees
// a non-zero exit knows the session ended abnormally (a killed process, a
// crashing plugin host), not because the user closed the window.
let shuttingDown = false;

function uriToFile(uri: string): string {
  const clean = uri.replace(/^file:\/\//, '');
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

const capabilities = {
  textDocumentSync: { openClose: true, change: 1 }, // 1 = full sync
  completionProvider: { triggerCharacters: [':', '.', '@'] },
  documentSymbolProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  hoverProvider: true,
  documentFormattingProvider: true,
};

function respond(id: number | string, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | string | null, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

// JSON-RPC 2.0 names three refusals: -32700 for a body that is not JSON, -32600
// for a body that is not a request, -32601 for a method this server does not
// implement. The last one used to be answered with `result: null`, which a
// client reads as "done, nothing to say" — exactly the shape of a real answer,
// so a version skew looked like an empty result instead of a missing method.
function isRequest(msg: unknown): msg is Message {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const candidate = msg as Message;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

// The id of a message that may not be a valid request; `null` when it cannot be
// read, which is what the error response must carry then.
function idOf(msg: unknown): number | string | null {
  const id = (msg as Message | null)?.id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params });
}

function publishDiagnostics(uri: string): void {
  const text = documents.get(uri) ?? '';
  const diags: LspDiagnostic[] = diagnostics(text, uriToFile(uri));
  notify('textDocument/publishDiagnostics', { uri, diagnostics: diags });
}

function handle(msg: Message): void {
  if (shuttingDown && msg.method !== 'exit') {
    // After `shutdown` the protocol allows only `exit`; anything else is refused
    // so a client cannot keep a doomed session alive with requests.
    if (msg.id !== undefined && msg.id !== null) {
      respondError(msg.id, -32600, 'server is shutting down');
    }
    return;
  }
  switch (msg.method) {
    case 'initialize': {
      respond(msg.id!, {
        capabilities,
        serverInfo: { name: 'arcod', version: '0.1.0' },
      });
      return;
    }
    case 'initialized':
      return;
    case 'shutdown':
      shuttingDown = true;
      respond(msg.id!, null);
      return;
    case 'exit':
      process.exit(shuttingDown ? 0 : 1);
      return;
    case 'textDocument/didOpen': {
      const { textDocument } = msg.params ?? {};
      documents.set(textDocument.uri, textDocument.text ?? '');
      publishDiagnostics(textDocument.uri);
      return;
    }
    case 'textDocument/didChange': {
      const { textDocument, contentChanges } = msg.params ?? {};
      const change = contentChanges?.[0];
      if (change && typeof change.text === 'string') documents.set(textDocument.uri, change.text);
      publishDiagnostics(textDocument.uri);
      return;
    }
    case 'textDocument/didClose': {
      documents.delete(msg.params?.textDocument?.uri);
      return;
    }
    case 'textDocument/completion': {
      const { textDocument, position } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, completions(text, position.line, position.character));
      return;
    }
    case 'textDocument/documentSymbol': {
      const { textDocument } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, documentSymbols(text));
      return;
    }
    case 'textDocument/definition': {
      const { textDocument, position } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, definition(text, position.line, position.character, textDocument.uri));
      return;
    }
    case 'textDocument/references': {
      const { textDocument, position } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, references(text, position.line, position.character, textDocument.uri));
      return;
    }
    case 'textDocument/hover': {
      const { textDocument, position } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, hover(text, position.line, position.character));
      return;
    }
    case 'textDocument/formatting': {
      const { textDocument } = msg.params ?? {};
      const text = documents.get(textDocument.uri) ?? '';
      respond(msg.id!, formatting(text, uriToFile(textDocument.uri)));
      return;
    }
    default:
      // Unknown notification: ignore (there is nothing to answer to). Unknown
      // request: -32601 with the method name, so the client's log says which
      // method it asked for and which server answered.
      if (msg.id !== undefined && msg.id !== null) {
        respondError(msg.id, -32601, 'method not found: ' + msg.method);
      }
  }
}

// The stream the answers go to. Defaults to stdout, which is what an editor
// sees; a test passes a PassThrough so the framing code runs in this process.
let out: NodeJS.WritableStream = process.stdout;

function write(payload: object): void {
  const body = JSON.stringify(payload);
  out.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}

// Editors always run the server as a child process, which is why the framing
// code was never measured: a split chunk or a message without Content-Length
// is exactly what a real editor produces, and nothing here was covered. The
// streams are a parameter now, so the same code runs in-process.
function serve(io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): void {
  out = io.output ?? process.stdout;
  shuttingDown = false;
  const input: NodeJS.ReadableStream = io.input ?? process.stdin;
  let buffer = Buffer.alloc(0);
  input.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Parse as many complete Content-Length-framed messages as are available.
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        // A malformed body must not kill the server.
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } });
        continue;
      }
      if (!isRequest(parsed)) {
        // Valid JSON that is not a request (`null`, an array, `{"id":1}`).
        respondError(idOf(parsed), -32600, 'invalid request: expected a JSON-RPC 2.0 request with a method');
        continue;
      }
      try {
        handle(parsed);
      } catch (error) {
        // Params the handler could not read are -32602; a notification has no
        // id to answer to, and the server keeps serving either way.
        if (parsed.id !== undefined && parsed.id !== null) {
          respondError(parsed.id, -32602, 'invalid params: ' + String(error));
        }
      }
    }
  });
}

export { serve };
