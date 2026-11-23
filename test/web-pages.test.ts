import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from '../src/parser.ts';
import { emitWeb } from '../src/emit/web.ts';
import { QR_SOURCE } from '../src/emit/qr-code.ts';

// Every page mode is a template with markers, and the page ships to a browser
// where nothing else checks it: a marker left in the HTML or a script that does
// not parse is invisible to `npm test` unless this file looks. The modes come
// from real examples, so the pages are the ones a user actually gets.

async function renderExample(path: string, title?: string): Promise<string> {
  const mod = parse(await readFile(new URL(path, import.meta.url), 'utf8'), 'main.arc');
  return emitWeb(mod, { maxBytes: 65536, title });
}

const PAGES = [
  ['../examples/quiz/main.arc', 'presentation'],
  ['../examples/chat/main.arc', 'chat'],
  ['../examples/onetimemessage/main.arc', 'spa'],
] as const;

// `__ARC_SSR_DATA__` is the one marker that is meant to survive: the service
// substitutes it with the first-screen result at request time.
const MARKER = /__[A-Z][A-Z0-9_]*__/g;

for (const [example, mode] of PAGES) {
  test(`the ${mode} page leaves no template marker behind`, async () => {
    const html = await renderExample(example);
    assert.deepEqual([...new Set(html.match(MARKER) ?? [])], []);
  });

  test(`every inline script of the ${mode} page parses`, async () => {
    const html = await renderExample(example);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0, 'the page ships a script');
    for (const [index, code] of scripts.entries()) {
      assert.doesNotThrow(() => new vm.Script(code), `${mode} script #${index} compiles`);
    }
  });
}

test('an SSR page keeps exactly the one marker the service replaces', async () => {
  const html = await renderExample('../examples/notes-ssr/main.arc');
  assert.deepEqual([...new Set(html.match(MARKER) ?? [])], ['__ARC_SSR_DATA__']);
  assert.equal((html.match(/__ARC_SSR_DATA__/g) ?? []).length, 1);
});

// The QR code is third-party generated code pasted as one opaque string. If it
// were spliced in as a replacement pattern (or truncated), the page would look
// fine and show no code at all, so the source is inserted verbatim and asked to
// actually produce a grid.
test('the presentation page embeds the QR source verbatim and it makes a code', async () => {
  const html = await renderExample('../examples/quiz/main.arc');
  assert.ok(html.includes(QR_SOURCE), 'the source lands byte for byte');

  const context = vm.createContext({ exports: undefined, define: undefined, module: undefined });
  vm.runInContext(QR_SOURCE, context);
  const code = vm.runInContext("qrcode(0,'M')", context) as {
    addData: (data: string) => void;
    make: () => void;
    getModuleCount: () => number;
    isDark: (row: number, col: number) => boolean;
  };
  code.addData('https://arcod.example/p/ABC123');
  code.make();
  const size = code.getModuleCount();
  assert.ok(size >= 21, `a version-1 code has 21 modules, got ${size}`);
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (code.isDark(row, col)) dark += 1;
  }
  assert.ok(dark > 0 && dark < size * size, 'the grid is neither empty nor solid');
});

// A slide body is author text and it lands inside a <script>. `$&`, `$'` and
// `$`+backtick are replacement patterns, so splicing the deck with a
// replacement *string* re-inserted `__DECK__` and copied the rest of the
// document into the JSON string: a page that fails to parse, from a sentence
// with a dollar sign in it.
test('a slide body with dollar patterns lands literally', async () => {
  const source = await readFile(new URL('../examples/quiz/main.arc', import.meta.url), 'utf8');
  const hostile = source.replace(
    'Developers, QA, product',
    () => 'Price $& paid and $` quoted, no pattern here',
  );
  const html = emitWeb(parse(hostile, 'main.arc'), { maxBytes: 65536 });
  assert.deepEqual([...new Set(html.match(MARKER) ?? [])], []);
  assert.ok(html.includes('Price $& paid and $` quoted, no pattern here'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(match[1]), `script #${index} still compiles`);
  }
});

test('a title with a dollar pattern lands literally', async () => {
  const html = await renderExample('../examples/onetimemessage/main.arc', 'Notes $& Co');
  assert.ok(html.includes('Notes $&amp; Co'), 'the escaped title keeps its dollar');
  assert.deepEqual([...new Set(html.match(MARKER) ?? [])], []);
});
