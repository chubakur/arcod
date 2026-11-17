import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';

// The generated page is the only UI most specs will ever have, so the a11y
// basics are part of the emitter's contract, not a later theme: a language, a
// label per control, aria-required for required parameters, and a live region
// for results that arrive after an async call.

const url = new URL('../examples/onetimemessage/main.arc', import.meta.url);

test('the generated page carries the a11y baseline', async () => {
  const mod = parse(await readFile(url, 'utf8'), 'main.arc');
  const html = emitWeb(mod, { maxBytes: 65536 });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /setAttribute\('role', 'status'\)/, 'results are announced');
  assert.match(html, /setAttribute\('aria-live', 'polite'\)/, 'the live region is polite');
  assert.match(html, /setAttribute\('aria-required', 'true'\)/, 'required params say so');
  assert.match(html, /autocomplete = 'off'/, 'autofill does not guess API parameters');
  assert.match(html, /label\.textContent = p\.name/, 'every control has a label');
});
