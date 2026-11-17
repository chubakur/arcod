import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { check } from '../src/check.ts';
import { emitOpenapi } from '../src/emit/openapi.ts';
import { adoptOpenapi } from '../src/adopt.ts';
import { formatSource } from '../src/fmt.ts';
import { diffSpecs } from '../src/diff.ts';

// Two promises the toolchain makes about itself: an emitted OpenAPI document
// can be adopted back into a spec that still checks, and formatting a spec
// twice changes nothing. Both are round trips, and neither had a test.

const example = (name: string) => new URL('../examples/' + name + '/main.arc', import.meta.url);
const examplesDir = new URL('../examples/', import.meta.url);

async function allExamples(): Promise<Array<{ name: string; source: string }>> {
  const names = (await readdir(examplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const out: Array<{ name: string; source: string }> = [];
  for (const name of names) {
    const source = await readFile(example(name), 'utf8').catch(() => null);
    if (source !== null) out.push({ name, source });
  }
  return out;
}

test('openapi -> adopt -> check closes the loop on every example', async () => {
  const list = await allExamples();
  assert.ok(list.length >= 10);
  for (const { name, source } of list) {
    const mod = parse(source, name + '/main.arc');
    const doc = emitOpenapi(mod);
    const adopted = adoptOpenapi(doc);
    const back = parse(adopted, name + '/adopted.arc');
    const errors = check(back).filter((item) => item.severity === 'error');
    assert.deepEqual(errors.map((item) => item.code + ' ' + item.message), [], name + ' survives the round trip');
  }
});

test('formatting is idempotent for every example', async () => {
  for (const { name, source } of await allExamples()) {
    const once = formatSource(source, 'main.arc');
    const twice = formatSource(once, 'main.arc');
    assert.equal(twice, once, name + ' is stable under a second fmt');
  }
});

test('a spec never differs from itself, and a diff is symmetric in existence', async () => {
  const a = await readFile(example('signup'), 'utf8');
  const b = await readFile(example('onetimemessage'), 'utf8');
  // A semantic diff keeps its two header lines by design (they say which files
  // were compared); what must not appear is a hunk.
  const self = diffSpecs(a, 'a.arc', a, 'a.arc');
  assert.match(self, /^--- a\.arc\n\+\+\+ a\.arc/);
  assert.equal(self.split('\n').slice(2).join('\n').trim(), '', 'no hunks for an identical spec');
  assert.ok(diffSpecs(a, 'a.arc', b, 'b.arc').length > 0, 'different specs differ');
  assert.ok(diffSpecs(b, 'b.arc', a, 'a.arc').length > 0, 'and differ in both directions');
});
