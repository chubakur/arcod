import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '../src/parser.ts';
import { emitWeb, pageStrings, ssrFirstScreenOp } from '../src/emit/web.ts';
import { emitService } from '../src/emit/service.ts';
import { printModule } from '../src/fmt.ts';
import { check } from '../src/check.ts';

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
    assert.match(html, /\"langLabel\":\"Language\"/);
    assert.match(html, /\"langLabel\":\"Язык\"/);
    assert.match(html, /select\.setAttribute\('aria-label'/, 'the picker is labelled in the chosen catalog');
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

test('render: ssr parses, survives fmt and warns until the service renders', () => {
  const source = LOCALIZED.split('  locale: "ru"').join('  render: ssr\n  locale: "ru"');
  const mod = parse(source, 'main.arc');
  assert.equal(mod.uis[0].render, 'ssr');
  const printed = printModule(mod);
  assert.match(printed, /render: ssr/);
  const diags = check(mod);
  const warning = diags.find((item) => item.code === 'W030');
  assert.ok(warning, 'W030 says ssr is not implemented yet');
  assert.equal(warning.severity, 'warning');
  // The default is static and prints nothing extra.
  const plain = parse(LOCALIZED, 'main.arc');
  assert.equal(plain.uis[0].render, 'static');
  assert.doesNotMatch(printModule(plain), /render:/);
  assert.equal(check(plain).filter((item) => item.code === 'W030').length, 0);
});

test('render rejects a value that is neither static nor ssr', () => {
  const source = LOCALIZED.split('  locale: "ru"').join('  render: ssg\n  locale: "ru"');
  assert.throws(() => parse(source, 'main.arc'), /render must be static or ssr/);
});

test('render: ssr makes the service serve the page itself', async () => {
  const mod = parse(LOCALIZED.split('  locale: "ru"').join('  render: ssr\n  locale: "ru"'), 'main.arc');
  const html = '<!doctype html><html lang="ru"><body>Notes</body></html>';
  const code = emitService(mod, { pages: [{ route: '/', html }] });
  assert.match(code, /const PAGES = \[\{"route":"\/","html":"/);
  assert.match(code, /'text\/html; charset=utf-8'/);
  assert.match(code, /PAGES\.find/);
  // Without pages the service is unchanged: no page is served.
  const plain = emitService(mod);
  assert.match(plain, /const PAGES = \[\];/);
});

test('the running service answers the ui route with the page', async () => {
  const { startService } = await import('./harness.ts');
  const withRead = LOCALIZED.replace(
    '  contract { public op create(text: string) -> Note { route: "POST /v1/notes" } }',
    '  contract {\n' +
    '    public op create(text: string) -> Note { route: "POST /v1/notes" }\n' +
    '    public op read(id: uuid) -> Note { route: "GET /v1/notes/:id" }\n' +
    '  }',
  );
  const source = withRead.split('  locale: "ru"').join('  render: ssr\n  locale: "ru"');
  const svc = await startService(source, { reference: true });
  try {
    const response = await fetch(svc.base + '/');
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/html/);
    const body = await response.text();
    assert.match(body, /^<!doctype html>/i);
    assert.match(body, /<html lang="ru"/);
  } finally {
    await svc.stop();
  }
});

test('an ssr page carries a data slot only when a GET can fill it', () => {
  const ssr = (source: string) => source.split('  locale: "ru"').join('  render: ssr\n  locale: "ru"');
  // Only POST here: there is nothing a server could fetch before the browser
  // says anything, so the page must not promise data.
  const postOnly = parse(ssr(LOCALIZED), 'main.arc');
  assert.equal(ssrFirstScreenOp(postOnly), null);
  assert.doesNotMatch(emitWeb(postOnly, { maxBytes: 65536 }), /__ARC_SSR_DATA__/);

  const withList = LOCALIZED.replace(
    '  contract { public op create(text: string) -> Note { route: "POST /v1/notes" } }',
    '  contract {\n' +
    '    public op create(text: string) -> Note { route: "POST /v1/notes" }\n' +
    '    public op list() -> list<Note> { route: "GET /v1/notes" }\n' +
    '  }',
  ).replace('uses Notes.create', 'uses Notes.create, Notes.list');
  const mod = parse(ssr(withList), 'main.arc');
  assert.equal(ssrFirstScreenOp(mod), 'list');
  const html = emitWeb(mod, { maxBytes: 65536 });
  assert.match(html, /"op":"list","data":__ARC_SSR_DATA__/);
  // The client hydrates that slot instead of issuing a second request.
  assert.match(html, /SSR\.op === op\.name && SSR\.data !== null/);
  // A parameterless GET is what makes the slot legal; a path parameter is not.
  const parameterized = LOCALIZED.replace(
    '  contract { public op create(text: string) -> Note { route: "POST /v1/notes" } }',
    '  contract { public op read(id: uuid) -> Note { route: "GET /v1/notes/:id" } }',
  ).replace('uses Notes.create', 'uses Notes.read');
  assert.equal(ssrFirstScreenOp(parse(ssr(parameterized), 'main.arc')), null);
  // No warning once there is a first screen; W030 still names a page that
  // claims ssr but can never render anything.
  assert.equal(check(mod).filter((item) => item.code === 'W030').length, 0);
  assert.equal(check(parse(ssr(LOCALIZED), 'main.arc')).filter((item) => item.code === 'W030').length, 1);
});

const SSR_LIST = [
    'module loc @0.1.0 {}',
    'type Note = { id: uuid, text: string }',
    'service Notes : http {',
    '  contract { public op list() -> list<Note> { route: "GET /v1/notes" } }',
    '}',
    'ui NotesUi {',
    '  impl: spa',
    '  route: "/"',
    '  title: "Notes"',
    '  uses Notes.list',
    '  render: ssr',
    '  locale: "ru"',
    '}',
].join('\n');

test('the service ships the first screen inside the html', async () => {
  const { startService } = await import('./harness.ts');
  const source = SSR_LIST;
  const id = '00000000-0000-4000-8000-000000000001';
  const list = [
    'export async function list(input, io) {',
    '  return { result: [{ id: ' + JSON.stringify(id) + ', text: "first screen" }] };',
    '}',
  ].join('\n');
  const svc = await startService(source, { impl: { list } });
  try {
    const response = await fetch(svc.base + '/');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /<!doctype html>/i);
    assert.doesNotMatch(body, /__ARC_SSR_DATA__/, 'the marker is always substituted');
    assert.match(body, new RegExp('"data":\\[\\{"id":"' + id + '","text":"first screen"'));
  } finally {
    await svc.stop();
  }
});

test('HEAD answers the ssr page without a body, with the GET length', async () => {
  const { startService } = await import('./harness.ts');
  const list = 'export async function list(input, io) { return { result: [] }; }';
  const svc = await startService(SSR_LIST, { impl: { list } });
  try {
    const get = await fetch(svc.base + '/');
    const body = await get.text();
    const head = await fetch(svc.base + '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body));
  } finally {
    await svc.stop();
  }
});

test('a failing first screen still serves the page, just without data', async () => {
  const { startService } = await import('./harness.ts');
  const boom = 'export async function list(input, io) { throw new Error("store down"); }';
  const svc = await startService(SSR_LIST, { impl: { list: boom } });
  try {
    const response = await fetch(svc.base + '/');
    assert.equal(response.status, 200);
    // Per-request data: nothing between the service and the reader may cache it.
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.text();
    assert.match(body, /<!doctype html>/i);
    assert.match(body, /"op":"list","data":null/, 'the marker becomes null, not a broken script');
    assert.doesNotMatch(body, /__ARC_SSR_DATA__/);
  } finally {
    await svc.stop();
  }
});

test('the ssr example ships the notes it just wrote', async () => {
  const { startService } = await import('./harness.ts');
  const dir = new URL('../examples/notes-ssr/', import.meta.url);
  const source = await readFile(new URL('main.arc', dir), 'utf8');
  const impl = {
    list: await readFile(new URL('impl/list.mjs', dir), 'utf8'),
    create: await readFile(new URL('impl/create.mjs', dir), 'utf8'),
  };
  const mod = parse(source, 'main.arc');
  assert.equal(check(mod).filter((item) => item.code === 'W030').length, 0, 'the example has a first screen');
  const svc = await startService(source, { impl });
  try {
    const created = await fetch(svc.base + '/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello ssr' }),
    });
    assert.ok(created.status < 300, 'create answers ' + created.status);
    const body = await (await fetch(svc.base + '/')).text();
    assert.match(body, /hello ssr/, 'the first screen is in the html');
    assert.match(body, /"op":"list","data":\[\{"id":/);
  } finally {
    await svc.stop();
  }
});

test('the static copy of an ssr page carries no data marker', async () => {
  const { buildExample } = await import('../src/build.ts');
  const { mkdtemp, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'arcod-ssr-static-'));
  const source = await read(new URL('../examples/notes-ssr/main.arc', import.meta.url), 'utf8');
  const built = await buildExample(parse(source, 'main.arc'), dir);
  const staticHtml = await read(join(built.dir, 'web', 'index.html'), 'utf8');
  assert.doesNotMatch(staticHtml, /__ARC_SSR_DATA__/, 'a static file cannot fill a marker');
  assert.match(staticHtml, /"op":"list","data":null/);
  const service = await read(join(built.dir, 'service', 'index.mjs'), 'utf8');
  assert.match(service, /__ARC_SSR_DATA__/, 'the service keeps the slot it fills');
});

test('an ssr build needs no web container in compose', async () => {
  const { buildExample } = await import('../src/build.ts');
  const { mkdtemp, writeFile, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const withRead = LOCALIZED.replace(
    '  contract { public op create(text: string) -> Note { route: "POST /v1/notes" } }',
    '  contract {\n' +
    '    public op create(text: string) -> Note { route: "POST /v1/notes" }\n' +
    '    public op read(id: uuid) -> Note { route: "GET /v1/notes/:id" }\n' +
    '  }',
  );
  const ssrSource = withRead.split('  locale: "ru"').join('  render: ssr\n  locale: "ru"');
  const staticSource = withRead;
  for (const [name, source, wantsWeb] of [['ssr', ssrSource, false], ['static', staticSource, true]] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'arcod-compose-' + name + '-'));
    await writeFile(join(dir, 'main.arc'), source, 'utf8');
    const built = await buildExample(parse(source, 'main.arc'), dir, { reference: true });
    const compose = await read(join(built.dir, 'docker-compose.yml'), 'utf8');
    if (wantsWeb) assert.match(compose, /\n  web:\n/);
    else assert.doesNotMatch(compose, /\n  web:\n/);
  }
});
