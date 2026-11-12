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

function notify(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params });
}

function publishDiagnostics(uri: string): void {
  const text = documents.get(uri) ?? '';
  const diags: LspDiagnostic[] = diagnostics(text, uriToFile(uri));
  notify('textDocument/publishDiagnostics', { uri, diagnostics: diags });
}

function handle(msg: Message): void {
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
      respond(msg.id!, null);
      return;
    case 'exit':
      process.exit(0);
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
      // Unknown notification: ignore. Unknown request: error.
      if (msg.id !== undefined && msg.id !== null) {
        respond(msg.id, null);
      }
  }
}

function write(payload: object): void {
  const body = JSON.stringify(payload);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}

function serve(): void {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
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
      try {
        handle(JSON.parse(body));
      } catch (error) {
        // A malformed message must not kill the server.
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } });
      }
    }
  });
}

export { serve };
