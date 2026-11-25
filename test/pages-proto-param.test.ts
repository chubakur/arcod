// Both interactive pages (presentation and chat) send an operation with the
// values the user typed: \`var v = values[p.name]\`. For a parameter called
// toString the read found Object.prototype.toString even when the page had no
// value for it, and the inherited function went into the query string as
// "function toString() { [native code] }". Both templates now ask for an own
// key; the test drives the emitted \`build\` function from the page itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PRESENTATION_PAGE } from '../src/emit/presentation-page.ts';
import { CHAT_PAGE } from '../src/emit/chat-page.ts';

function block(source: string, from: string): string {
  const at = source.indexOf(from);
  assert.ok(at >= 0, 'missing ' + from);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced block: ' + from);
}

const OP = {
  method: 'GET',
  path: '/v1/board',
  params: [
    { name: 'toString', where: 'query', kind: 'string' },
    { name: 'code', where: 'query', kind: 'string' },
  ],
};

test('the presentation page sends no value for a parameter it has none for', () => {
  const sandbox: Record<string, unknown> = { URLSearchParams, headers: () => ({}) };
  vm.createContext(sandbox);
  vm.runInContext(block(PRESENTATION_PAGE, 'function fillPath'), sandbox);
  vm.runInContext(block(PRESENTATION_PAGE, 'function build'), sandbox);
  const build = sandbox.build as (op: unknown, values: unknown) => { url: string };
  const empty = build(OP, {});
  assert.equal(empty.url, '/v1/board');
  assert.doesNotMatch(empty.url, /native code/);
  const filled = build(OP, { toString: 'x', code: 'abc' });
  assert.equal(filled.url, '/v1/board?toString=x&code=abc');
});

test('the chat page builds its request the same way', async () => {
  const seen: string[] = [];
  const sandbox: Record<string, unknown> = {
    URLSearchParams,
    headers: () => ({}),
    fetch: async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, text: async () => '{}' };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(block(CHAT_PAGE, 'function fillPath'), sandbox);
  vm.runInContext(block(CHAT_PAGE, 'async function request'), sandbox);
  const request = sandbox.request as (op: unknown, values: unknown) => Promise<unknown>;
  await request(OP, {});
  assert.deepEqual(seen, ['/v1/board']);
  await request(OP, { toString: 'x' });
  assert.deepEqual(seen, ['/v1/board', '/v1/board?toString=x']);
});
