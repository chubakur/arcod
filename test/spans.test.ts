import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parser.ts';
import { buildExample } from '../src/build.ts';

// An operation span says how long a request took; a store span says where the
// time went. Store adapters are wrapped in a proxy so every call becomes a
// child span with the capability and the entity it touched, without editing
// the adapters themselves.

async function codeOf(example: string): Promise<string> {
  const url = new URL('../examples/' + example + '/main.arc', import.meta.url);
  const ast = parse(await readFile(url, 'utf8'), 'main.arc');
  const implDir = fileURLToPath(new URL('../examples/' + example + '/impl', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'arcod-span-'));
  const built = await buildExample(ast, dir, { implDir });
  return readFile(join(built.dir, 'service', 'index.mjs'), 'utf8');
}

test('store calls become child spans with capability and entity', async () => {
  for (const [example, capability] of [['tasks', 'kv'], ['tasks-sql', 'sql']] as const) {
    const code = await codeOf(example);
    assert.ok(code.includes('function spannedStore(inner, capability)'), example + ': the wrapper exists');
    assert.ok(code.includes("const name = 'store.' + String(prop)"), example + ': every method is named store.<op>');
    assert.ok(code.includes('withSpan(name, { capability, entity }'), example + ': the span carries both attributes');
    assert.ok(code.includes('const store = spannedStore('), example + ': the adapter is wrapped');
    assert.ok(code.includes(", '" + capability + "')"), example + ': the capability is ' + capability);
  }
});

test('spans parent the store call under the operation span', async () => {
  const code = await codeOf('tasks');
  // withSpan runs the child inside spanCtx.run(span, fn), so startSpan picks
  // the operation span as parent instead of starting a new trace.
  assert.ok(code.includes('return await spanCtx.run(span, fn);'), 'ALS carries the parent');
  assert.ok(code.includes('const parent = spanCtx.getStore();'), 'startSpan reads the parent');
});
