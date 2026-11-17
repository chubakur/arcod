import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { emitWeb, pageStrings } from '../src/emit/web.ts';

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

// A locale is a property of the ui block, not a build flag: the same spec
// always renders the same page.
const LOCALIZED = [
  'module loc @0.1.0 {}',
  'type Note = { id: uuid, text: string }',
  'service Notes : http {',
  '  contract { public op create(text: string) -> Note { route: "POST /v1/notes" } }',
  '}',
  'ui NotesUi {',
  '  impl: spa',
  '  route: "/"',
  '  title: "Notes"',
  '  uses Notes.create',
  '  locale: "ru"',
  '}',
].join('\n');

test('a ui locale sets the document language and the label catalog', () => {
  const html = emitWeb(parse(LOCALIZED, 'main.arc'), { maxBytes: 65536 });
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /"token":"Токен доступа"/, 'the Russian catalog is embedded');
  assert.match(html, /data-i18n="save"/, 'markup keeps the English default and a key');
  assert.match(html, /function t\(key, fallback\)/, 'one lookup, English fallback');
});

test('an unshipped locale falls back to English labels, keeps its tag', () => {
  const html = emitWeb(parse(LOCALIZED.replace('"ru"', '"pt-BR"'), 'main.arc'), { maxBytes: 65536 });
  assert.match(html, /<html lang="pt-BR">/);
  assert.match(html, /"token":"Access token"/, 'labels fall back to the base catalog');
  assert.equal(pageStrings('pt-BR').lang, 'pt-BR');
  assert.equal(pageStrings(null).lang, 'en');
});

test('a malformed locale is rejected at parse time', () => {
  assert.throws(
    () => parse(LOCALIZED.replace('"ru"', '"russian!"'), 'main.arc'),
    /BCP-47/,
  );
});
