import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasm.buffer);

const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (sources) => new onig.OnigScanner(sources),
    createOnigString: (value) => new onig.OnigString(value),
  }),
  loadGrammar: async (scope) => {
    if (scope !== 'source.arcod') return null;
    const raw = await readFile(new URL('../syntaxes/arcod.tmLanguage.json', import.meta.url), 'utf8');
    return vsctm.parseRawGrammar(raw, 'arcod.tmLanguage.json');
  },
});

const grammar = await registry.loadGrammar('source.arcod');

function tokenize(line) {
  const result = grammar.tokenizeLine(line, vsctm.INITIAL);
  return result.tokens.map((token) => ({
    text: line.slice(token.startIndex, token.endIndex),
    scopes: token.scopes,
  }));
}

function scopesOf(line, needle) {
  const token = tokenize(line).find((item) => item.text === needle);
  assert.ok(token, 'no token ' + JSON.stringify(needle) + ' in ' + JSON.stringify(line));
  return token.scopes.join(' ');
}

function scopesContaining(line, needle) {
  const token = tokenize(line).find((item) => item.text.includes(needle));
  assert.ok(token, 'no token containing ' + JSON.stringify(needle) + ' in ' + JSON.stringify(line));
  return token.scopes.join(' ');
}

test('declarations are highlighted', () => {
  assert.match(scopesOf('module chat @0.1.0 {', 'module'), /keyword\.declaration\.module/);
  assert.match(scopesOf('module chat @0.1.0 {', 'chat'), /entity\.name\.type\.module/);
  assert.match(scopesOf('module chat @0.1.0 {', '@0.1.0'), /constant\.other\.version/);

  assert.match(scopesOf('service Chat : http {', 'service'), /keyword\.declaration/);
  assert.match(scopesOf('service Chat : http {', 'Chat'), /entity\.name\.type/);
  assert.match(scopesOf('type ConversationId = uuid', 'ConversationId'), /entity\.name\.type/);
  assert.match(scopesOf('type ConversationId = uuid', 'uuid'), /support\.type\.primitive/);
  assert.match(scopesOf('workflow Nightly {', 'Nightly'), /entity\.name\.type/);
  assert.match(scopesOf('environment prod {', 'environment'), /keyword\.declaration/);
});

test('operations and clauses are highlighted', () => {
  assert.match(scopesOf('    public op send(id: ConversationId) -> Message {', 'op'), /keyword\.declaration/);
  assert.match(scopesOf('    public op send(id: ConversationId) -> Message {', 'send'), /entity\.name\.function/);
  assert.match(scopesOf('  route: "POST /v1/conversations"', 'route'), /keyword\.other\.clause/);
  assert.match(scopesContaining('  route: "POST /v1/conversations"', 'POST /v1/conversations'), /string\.quoted\.double/);
  assert.match(scopesOf('      needs: prepare', 'needs'), /keyword\.other\.clause/);
  assert.match(scopesOf('      onFail: stop', 'onFail'), /keyword\.other\.clause/);
  assert.match(scopesOf('  effects: store.get', 'store'), /variable\.other\.object/);
  assert.match(scopesOf('  effects: store.get', 'get'), /variable\.other\.property/);
});

test('providers are separated from capabilities', () => {
  assert.match(scopesOf('  bind llm -> ollama(host: "host.docker.internal", port: 11434)', 'ollama'), /support\.class\.provider/);
  assert.match(scopesOf('  deploy yandex(region: "ru-central1")', 'yandex'), /support\.class\.provider/);
  assert.match(scopesOf('  deploy docker', 'docker'), /support\.class\.provider/);
  assert.match(scopesOf('  uses store: kv(ttl: 31536000s)', 'kv'), /support\.class\.capability/);
  assert.match(scopesOf('  uses store: kv(ttl: 31536000s)', '31536000s'), /constant\.numeric\.duration/);
});

test('comments and triggers are highlighted', () => {
  assert.match(scopesOf('  // комментарий', '// комментарий'), /comment\.line/);
  assert.match(scopesOf('  trigger cron("0 3 * * *", tz: "Europe/Moscow")', 'cron'), /support\.function\.trigger/);
  assert.match(scopesContaining('  trigger cron("0 3 * * *", tz: "Europe/Moscow")', '0 3 * * *'), /string\.quoted\.double/);
});

test('the real examples tokenize without throwing', async () => {
  const files = ['../../../examples/chat/main.arc', '../../../examples/files/main.arc', '../../../examples/project1/main.arc'];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    let state = vsctm.INITIAL;
    for (const line of source.split(/\r?\n/)) {
      const result = grammar.tokenizeLine(line, state);
      state = result.ruleStack;
      assert.ok(result.tokens.length >= 0);
    }
  }
});
