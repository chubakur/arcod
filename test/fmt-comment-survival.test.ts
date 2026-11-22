// Every comment a spec carries must survive a format pass. The unit tests pin
// one place at a time; this one takes every example and appends a marker to
// each code line — an opening brace, a closing brace, a `when {` — so a comment
// the printer has no anchor for shows up as a lost marker. It found four such
// places at once (module meta open and close, the module's own closing brace,
// and the example section braces).
//
// The examples cover services, environments and ui blocks, but no example
// declares a `workflow`, so the drill also runs over snippets below: that is
// the only place a workflow's clauses, steps and their closings get a marker.
// A marker is skipped on a line that already opens a comment (a marker inside
// a block comment is not code) and on the continuation of a multi-line one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatSource } from '../src/fmt.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const examples = readdirSync(join(ROOT, 'examples'))
  .filter((dir) => existsSync(join(ROOT, 'examples', dir, 'main.arc')));

const MARKERS: Array<{ open: string; close: string }> = [
  { open: '// c', close: '' },
  { open: '/* c', close: ' */' },
];

// Appends `marker<i>` to every code line, formats, and returns the line numbers
// whose marker is gone. A line inside a block comment is not code: marking it
// would ask the printer to keep a marker the lexer never produced.
function lostMarkers(source: string, open: string, close: string, file: string): string[] {
  const lines = source.split('\n');
  let inBlock = false;
  const isCode = lines.map((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return false;
    }
    if (trimmed === '' || trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return false;
    }
    return true;
  });
  const tagged = lines
    .map((line, i) => (isCode[i] ? line + '  ' + open + i + close : line))
    .join('\n');
  const out = formatSource(tagged, file);
  const missing: string[] = [];
  lines.forEach((line, i) => {
    if (!isCode[i]) return;
    const text = open + i + close;
    if (!out.includes(text + '\n') && !out.endsWith(text)) missing.push(i + 1 + ': ' + line.trim().slice(0, 60));
  });
  assert.deepEqual(missing, [], file + ' lost comments on: ' + missing.join(' | '));
  assert.equal(formatSource(out, file), out, file + ' is not idempotent with comments');
  return missing;
}

for (const marker of MARKERS) {
test('every example keeps ' + marker.open + ' appended to each of its code lines', () => {
  assert.ok(examples.length > 0, 'no examples found');
  for (const dir of examples) {
    const file = join('examples', dir, 'main.arc');
    lostMarkers(readFileSync(join(ROOT, file), 'utf8'), marker.open, marker.close, file);
  }
});
}

// Constructs no example declares. Each snippet is a whole module because the
// printer keys anchors by node offset, and offsets only line up when the module
// is parsed from the first byte.
const SNIPPETS: Array<{ name: string; source: string }> = [
  {
    name: 'workflow: every clause and step clause',
    source: [
      'module Wf { meta { owner: "@probe" } }',
      '',
      '// a note on the workflow itself',
      'workflow Nightly {',
      '  // before the trigger',
      '  trigger cron("0 3 * * *", tz: "Europe/Moscow")',
      '  overlap: skip',
      '  catchup: last',
      '  retry: 2',
      '  timeout: 30m',
      '',
      '  step prepare() -> string {',
      '    // before the call',
      '    call: Reports.prepare',
      '    effects: store.set',
      '    timeout: 30s',
      '    retry: 3',
      '  }',
      '',
      '  // between the steps',
      '  step render(snapshot: string) -> string {',
      '    call: Reports.render',
      '    needs: prepare',
      '    onFail: skip',
      '  }',
      '',
      '  step send(report: string) -> string {',
      '    call: Reports.send',
      '    needs: render',
      '    onFail: stop',
      '  }',
      '  // before the workflow closes',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'workflow: delayed and one-shot triggers',
    source: [
      'module Wf2 { meta { owner: "@probe" } }',
      '',
      'workflow Delayed {',
      '  trigger after 30s',
      '  step tick() {',
      '    call: Reports.tick',
      '  }',
      '}',
      '',
      'workflow Once {',
      '  trigger at(2026-11-18T12:00:05Z)',
      '  step tick() {',
      '    call: Reports.tick',
      '  }',
      '}',
      '',
      'workflow Chained {',
      '  trigger after Once',
      '  step tick() {',
      '    call: Reports.tick',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
];

for (const marker of MARKERS) {
  test('upstream snippets keep ' + marker.open + ' on every code line', () => {
    for (const snippet of SNIPPETS) {
      lostMarkers(snippet.source, marker.open, marker.close, 'snippet:' + snippet.name);
    }
  });
}
