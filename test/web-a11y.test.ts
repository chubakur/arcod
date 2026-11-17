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
  assert.match(html, /<html lang="en" data-theme="auto">/);
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
  assert.match(html, /<html lang="ru" data-theme="auto">/);
  assert.match(html, /"token":"Токен доступа"/, 'the Russian catalog is embedded');
  assert.match(html, /data-i18n="save"/, 'markup keeps the English default and a key');
  assert.match(html, /function t\(key, fallback\)/, 'one lookup, English fallback');
});

test('an unshipped locale falls back to English labels, keeps its tag', () => {
  const html = emitWeb(parse(LOCALIZED.replace('"ru"', '"pt-BR"'), 'main.arc'), { maxBytes: 65536 });
  assert.match(html, /<html lang="pt-BR" data-theme="auto">/);
  assert.match(html, /"token":"Access token"/, 'labels fall back to the base catalog');
  assert.equal(pageStrings('pt-BR').lang, 'pt-BR');
  assert.equal(pageStrings(null).lang, 'en');
});

test('a theme selects a token palette, auto follows the OS', () => {
  const auto = emitWeb(parse(LOCALIZED, 'main.arc'), { maxBytes: 65536 });
  assert.match(auto, /<html lang="ru" data-theme="auto">/, 'auto is the default');
  assert.match(auto, /prefers-color-scheme: dark/, 'auto has a dark branch');
  assert.match(auto, /background: var\(--surface\)/, 'the page reads tokens, not colors');
  assert.doesNotMatch(auto, /color: #fff/, 'no hard-coded text color survives');
  const dark = emitWeb(parse(LOCALIZED.replace('locale: "ru"', 'locale: "ru"\n  theme: dark'), 'main.arc'), { maxBytes: 65536 });
  assert.match(dark, /data-theme="dark"/);
  assert.match(dark, /--surface: #0b1020/);
  assert.throws(
    () => parse(LOCALIZED.replace('locale: "ru"', 'locale: "ru"\n  theme: neon'), 'main.arc'),
    /theme must be auto, light or dark/,
  );
});

test('a malformed locale is rejected at parse time', () => {
  assert.throws(
    () => parse(LOCALIZED.replace('"ru"', '"russian!"'), 'main.arc'),
    /BCP-47/,
  );
});

// B12: the chat and presentation layouts read static labels from the same
// catalog as the form page. Slide titles and bodies are author text; only the
// chrome is translated, and the markup keeps English as the no-JS fallback.
const chatUrl = new URL('../examples/chat/main.arc', import.meta.url);
const quizUrl = new URL('../examples/quiz/main.arc', import.meta.url);

test('the chat layout localizes its static labels', async () => {
  const mod = parse(await readFile(chatUrl, 'utf8'), 'main.arc');
  mod.uis[0].locale = 'ru';
  const html = emitWeb(mod, { maxBytes: 2_000_000 });
  assert.match(html, /<html lang="ru">/);
  assert.ok(html.includes('data-i18n="chatSend"'), 'the button is labelled from the catalog');
  assert.ok(html.includes('Отправить'), 'the Russian label is in the page');
  assert.ok(html.includes('data-i18n-ph="chatPlaceholder"'), 'the composer placeholder is catalogued');
  assert.ok(!html.includes('__STRINGS__'), 'the catalog is expanded');
  assert.ok(html.includes('New conversation'), 'English stays as the no-JS fallback');
});

test('chat and presentation pages expose the declared locale picker', async () => {
  for (const file of [chatUrl, quizUrl]) {
    const mod = parse(await readFile(file, 'utf8'), 'main.arc');
    mod.uis[0].locale = 'ru';
    mod.uis[0].locales = ['en', 'ru'];
    const html = emitWeb(mod, { maxBytes: 2_000_000 });
    assert.match(html, /var LOCALES = \["en","ru"\];/);
    assert.match(html, /id="lang"/);
    assert.match(html, /CATALOGS\[wanted\]/);
    assert.ok(!html.includes('__LANG_RUNTIME__'), 'the runtime is expanded');
    assert.ok(html.includes('"token":"Токен доступа"'), 'the Russian catalog is embedded');
  }
});

test('the presentation layout localizes its chrome, not the slides', async () => {
  const mod = parse(await readFile(quizUrl, 'utf8'), 'main.arc');
  mod.uis[0].locale = 'ru';
  const html = emitWeb(mod, { maxBytes: 2_000_000 });
  assert.match(html, /<html lang="ru">/);
  assert.ok(html.includes('"presNext":"Далее →"'), 'the catalog carries the deck chrome');
  assert.ok(html.includes("t('presNext')"), 'the button reads the catalog');
  assert.ok(html.includes(mod.uis[0].slides[0].title), 'a slide title is not translated');
  assert.ok(!html.includes('__STRINGS__'));
});

// A declared list of locales turns the static page into a switcher: every
// catalog is embedded once, and ?lang=<tag> chooses one on load. An unknown tag
// is not an error, it falls back to the declared default.
const SWITCHED = LOCALIZED.replace('  locale: "ru"', '  locale: "ru"' + '\n' + '  locales: "en, ru"');

test('declared locales embed every catalog and a picker', () => {
  const html = emitWeb(parse(SWITCHED, 'main.arc'), { maxBytes: 65536 });
  assert.match(html, /<html lang="ru"/);
  assert.match(html, /var LOCALES = \["en","ru"\];/);
  assert.match(html, /"en":\{/);
  assert.match(html, /"ru":\{/);
  assert.match(html, /<select id="lang" hidden aria-label="Language">/);
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('lang'\)/, 'the tag comes from the URL');
  assert.match(html, /wanted && CATALOGS\[wanted\] \? wanted : BASE_LANG/, 'unknown tags fall back');
});

test('a locale outside the declared list is rejected', () => {
  const outside = LOCALIZED.replace('  locale: "ru"', '  locale: "ru"' + '\n' + '  locales: "en"');
  assert.throws(() => parse(outside, 'main.arc'), /locale must be one of the declared locales/);
  const badTag = LOCALIZED.replace('  locale: "ru"', '  locales: "en, russian"');
  assert.throws(() => parse(badTag, 'main.arc'), /BCP-47/);
});

test('declared locales without locale default to the first tag', () => {
  const first = LOCALIZED
    .replace('  locale: "ru"\n', '')
    .replace('  title: "Notes"', '  title: "Notes"' + '\n' + '  locales: "ru, en"');
  const html = emitWeb(parse(first, 'main.arc'), { maxBytes: 65536 });
  assert.match(html, /<html lang="ru"/);
});
