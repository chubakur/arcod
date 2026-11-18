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
const lines = src.split('\n');

// Positions are derived from the source instead of being hard-coded: a
// reformatted example must not turn into a stale (line, character) pair.
function lineOf(needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, 'no line contains ' + JSON.stringify(needle));
  return index;
}

function positionOf(needle, token) {
  const line = lineOf(needle);
  const character = lines[line].indexOf(token);
  assert.notEqual(character, -1, 'no ' + JSON.stringify(token) + ' on ' + JSON.stringify(lines[line]));
  return { line, character };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out after ' + ms + 'ms waiting for ' + what)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('the LSP client round-trips initialize, diagnostics and symbols', { timeout: 30000 }, async (t) => {
  const client = new LspClient();
  // Cleanup runs even when an assertion fails or the test times out: an
  // orphaned server process is what used to keep `node --test` (and CI) alive.
  t.after(() => client.dispose());
  client.start('node', [server]);

  const init = await client.request('initialize', { capabilities: {} }, 10000);
  assert.ok(init.capabilities.completionProvider, 'server advertises completion');
  client.notify('initialized', {});

  const diagnosticsSeen = new Promise((resolve) => {
    client.onNotification('textDocument/publishDiagnostics', resolve);
  });

  client.notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'arcod', version: 1, text: src },
  });

  const published = await withTimeout(diagnosticsSeen, 10000, 'textDocument/publishDiagnostics');
  assert.equal(Array.isArray(published.diagnostics), true);

  const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri: URI } }, 10000);
  assert.equal(symbols[0].name, 'chat');

  const sendLine = lineOf('op send(id: ConversationId');
  const defPosition = positionOf('op send(id: ConversationId', 'ConversationId');
  const defs = await client.request(
    'textDocument/definition',
    { textDocument: { uri: URI }, position: defPosition },
    10000,
  );
  assert.equal(defs.length, 1, 'definition of ConversationId resolves to one place');
  assert.equal(defs[0].range.start.line, lineOf('type ConversationId = uuid'), 'definition jumps to the type declaration');

  const completions = await client.request(
    'textDocument/completion',
    { textDocument: { uri: URI }, position: { line: 2, character: 0 } },
    10000,
  );
  assert.ok(completions.length > 0, 'completion returns items');
});

test('a request to a silent server rejects instead of hanging', { timeout: 20000 }, async (t) => {
  const client = new LspClient();
  // The child reads stdin and never answers: the timeout is the only way out.
  t.after(() => client.dispose());
  client.start(process.execPath, ['-e', 'process.stdin.resume();']);

  await assert.rejects(
    () => client.request('initialize', { capabilities: {} }, 300),
    /did not answer initialize within 300ms/,
  );
});
