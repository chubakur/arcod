import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completionsFor, declarationsFromText, findDeclaration, occurrencesOf, qualifiedAt, symbolsFromText } from '../out/model.js';

const source = await readFile(new URL('../../../examples/chat/main.arc', import.meta.url), 'utf8');

test('the outline understands the spec', () => {
  const symbols = symbolsFromText(source);
  const names = symbols.map((item) => item.name + ':' + item.kind);
  assert.ok(names.includes('chat:module'));
  assert.ok(names.includes('Chat:service'));
  assert.ok(names.includes('ConversationId:type'));
  assert.ok(names.includes('NotFound:error'));
  assert.ok(names.includes('start:operation'));
  assert.ok(names.includes('send:operation'));
  assert.ok(names.includes('Web:ui'));
  assert.ok(names.includes('dev:environment'));
  assert.ok(names.includes('prod:environment'));

  const send = symbols.find((item) => item.name === 'send');
  assert.equal(send && send.container, 'Chat');
});

test('completion follows the context, not the name', () => {
  const labels = (line, prefix = '') => completionsFor(line, prefix, []).map((item) => item.label);

  assert.ok(labels('  uses store: ').includes('llm'));
  assert.ok(labels('  uses store: ').includes('sql'));
  assert.ok(labels('use capability arcod.std.').includes('arcod.std.llm'));

  assert.ok(labels('  bind llm -> ').includes('ollama'));
  assert.ok(labels('  bind llm -> ').includes('openai'));
  assert.ok(labels('  bind llm -> ').includes('postgres'));

  assert.deepEqual(labels('  deploy '), ['docker', 'aws', 'yandex', 'kubernetes']);
  assert.deepEqual(labels('  layout: '), ['forms', 'chat']);
  assert.deepEqual(labels('  overlap: '), ['skip', 'queue', 'parallel']);
  assert.deepEqual(labels('  catchup: '), ['none', 'last', 'all']);
  assert.deepEqual(labels('  onFail: '), ['stop', 'skip', 'retry', 'continue']);
  assert.deepEqual(labels('  trigger '), ['cron', 'event', 'manual', 'after']);
});

test('declarations are indexed with their containers', () => {
  const declarations = declarationsFromText(source);
  const byName = (name) => declarations.filter((item) => item.name === name);

  assert.ok(byName('Chat').some((item) => item.kind === 'service'));
  assert.ok(byName('ConversationId').some((item) => item.kind === 'type'));
  assert.ok(byName('NotFound').some((item) => item.kind === 'error'));
  assert.ok(byName('Store').length === 0);

  const send = byName('send').find((item) => item.kind === 'op');
  assert.ok(send, 'send is an operation');
  assert.equal(send.container, 'Chat');

  const storage = byName('store')[0];
  assert.equal(storage.kind, 'alias');

  const llmBind = byName('llm').find((item) => item.kind === 'alias' && item.signature.includes('bind'));
  assert.ok(llmBind, 'a bind declares an alias too');
});

test('definition resolution prefers the nearest, then the named container', () => {
  const declarations = declarationsFromText(source);

  const chat = findDeclaration(declarations, 'Chat', 999);
  assert.equal(chat.kind, 'service');

  const send = findDeclaration(declarations, 'send', 999);
  assert.equal(send.kind, 'op');
  assert.equal(send.container, 'Chat');

  const typed = findDeclaration(declarations, 'ConversationId', 0);
  assert.equal(typed.kind, 'type');
  assert.ok(typed.line > 0, 'a forward declaration is still found');
});

test('qualified names resolve the member inside the owner', () => {
  const line = '  call: Reports.prepare';
  assert.deepEqual(qualifiedAt(line, line.indexOf('Reports') + 2), { owner: 'Reports', member: 'prepare' });
  assert.deepEqual(qualifiedAt(line, line.indexOf('prepare') + 3), { owner: 'Reports', member: 'prepare' });
  assert.equal(qualifiedAt('  route: "GET /v1/x"', 4), null);

  const occurrences = occurrencesOf(source, 'send');
  assert.ok(occurrences.length >= 2, 'declaration and usages');
});

test('the default list mixes keywords and declarations from the file', () => {
  const symbols = symbolsFromText(source);
  const items = completionsFor('  ', '', symbols).map((item) => item.label);
  assert.ok(items.includes('service'));
  assert.ok(items.includes('bytes'));
  assert.ok(items.includes('Chat'), 'services from the file');
  assert.ok(items.includes('ConversationId'), 'types from the file');

  const filtered = completionsFor('  ', 'Con', symbols).map((item) => item.label);
  assert.ok(filtered.includes('ConversationId'), 'types from the file match the prefix');
});
