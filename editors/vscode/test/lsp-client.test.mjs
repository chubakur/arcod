import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { LspClient } = require('../out/lsp-client.js');

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const server = path.join(repo, 'bin', 'arcod-lsp.mjs');
const src = readFileSync(path.join(repo, 'examples', 'chat', 'main.arc'), 'utf8');

const URI = 'file:///chat/main.arc';

test('the LSP client round-trips initialize, diagnostics and symbols', async () => {
  const client = new LspClient();
  client.start('node', [server]);

  const init = await client.request('initialize', { capabilities: {} });
  assert.ok(init.capabilities.completionProvider, 'server advertises completion');
  client.notify('initialized', {});

  const diagnosticsSeen = new Promise((resolve) => {
    client.onNotification('textDocument/publishDiagnostics', resolve);
  });

  client.notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'arcod', version: 1, text: src },
  });

  const published = await diagnosticsSeen;
  assert.equal(Array.isArray(published.diagnostics), true);

  const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri: URI } });
  assert.equal(symbols[0].name, 'chat');

  const defs = await client.request('textDocument/definition', {
    textDocument: { uri: URI },
    position: { line: 37, character: 15 },
  });
  assert.equal(defs.length, 1);

  const completions = await client.request('textDocument/completion', {
    textDocument: { uri: URI },
    position: { line: 2, character: 0 },
  });
  assert.ok(completions.length > 0, 'completion returns items');

  client.dispose();
});
