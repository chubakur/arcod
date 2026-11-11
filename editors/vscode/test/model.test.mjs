import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completionsFor, symbolsFromText } from '../out/model.js';

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
