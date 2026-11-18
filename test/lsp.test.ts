import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  completions, definition, diagnostics, documentSymbols, formatting, hover, references,
  CompletionKind, Severity, SymbolKind,
} from '../src/lsp.ts';

const chat = await readFile(new URL('../examples/chat/main.arc', import.meta.url), 'utf8');
const MINIMAL = [
  'module demo @0.1.0 {',
  '}',
  '',
  'type UserId = string',
  'enum Status { open, closed }',
  '',
  'service Api : http {',
  '  contract {',
  '    public op get(id: UserId) -> Status {',
  '      route: "GET /v1/get"',
  '    }',
  '  }',
  '}',
  '',
  'environment dev {',
  '  deploy docker',
  '}',
].join('\n');

// Position on a specific line, pointing at needle shifted by offset chars.
function pos(text: string, lineIdx: number, needle: string, offset = 0): { line: number; character: number } {
  const line = text.split('\n')[lineIdx];
  const idx = line.indexOf(needle);
  if (idx < 0) throw new Error('not found: ' + needle + ' on line ' + lineIdx);
  return { line: lineIdx, character: idx + offset };
}

test('diagnostics: a valid spec has no errors, a broken one has a parse error', () => {
  const good = diagnostics(MINIMAL, 'demo.arc');
  assert.equal(good.some((d) => d.severity === Severity.Error), false, JSON.stringify(good));

  const broken = 'module demo @0.1.0 {\n  type = =\n';
  const errs = diagnostics(broken, 'demo.arc');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].severity, Severity.Error);
  assert.equal(errs[0].source, 'arcod');
});

test('document symbols nest services under the module', () => {
  const syms = documentSymbols(chat);
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, 'chat');
  assert.equal(syms[0].kind, SymbolKind.Module);
  const names = syms[0].children!.map((s) => s.name);
  assert.ok(names.includes('Chat'));
  assert.ok(names.includes('ConversationId'));
  assert.ok(names.includes('Web'));
  assert.ok(names.includes('dev'));
});

test('completion offers keywords and declared symbols, never dead keywords', () => {
  const all = completions(MINIMAL, 2, 0); // line 2 is blank: empty prefix
  const labels = all.map((i) => i.label);
  assert.ok(labels.includes('service'), 'keyword service');
  assert.ok(labels.includes('UserId'), 'type UserId');
  assert.ok(labels.includes('Api'), 'service Api');
  assert.ok(labels.includes('Status'), 'enum Status');
  const kw = all.find((i) => i.label === 'service');
  assert.equal(kw!.kind, CompletionKind.Keyword);
  assert.ok(!labels.includes('policy'), 'dead keyword policy is not offered');
  assert.ok(!labels.includes('since'), 'dead keyword since is not offered');
});

test('inside a ui block the completions are its fields', () => {
  const source = MINIMAL.replace(
    'environment dev {',
    'ui Web {\n  kind: spa\n  route: "/"\n  title: "Demo"\n\n  uses Api.get\n}\n\nenvironment dev {',
  );
  const lines = source.split('\n');
  const uiStart = lines.findIndex((line) => line.trim() === 'ui Web {');
  const uiLine = lines.findIndex((line, idx) => idx > uiStart && line === '');
  // An empty line inside the block: no prefix, so every field is offered.
  assert.ok(uiLine > 0, 'the ui block has a blank line');
  const items = completions(source, uiLine, 0);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('render'), 'render is a ui field');
  assert.ok(labels.includes('locales'), 'locales is a ui field');
  assert.ok(!labels.includes('service'), 'keywords step back inside a ui block');
  const render = items.find((i) => i.label === 'render')!;
  assert.equal(render.kind, CompletionKind.Field);
  assert.match(String(render.insertText), /^render: /);
  assert.equal(render.sortText, '0render', 'fields sort before keywords');

  const kindLine = lines.findIndex((line) => line.includes('kind: spa'));
  const filtered = completions(source, kindLine, 5);
  assert.deepEqual(
    filtered.filter((i) => i.kind === CompletionKind.Field).map((i) => i.label),
    ['kind'],
  );
});

test('completion filters by the prefix under the cursor', () => {
  const at = pos(MINIMAL, 4, 'Status', 2);
  const items = completions(MINIMAL, at.line, at.character);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('Status'));
});

test('definition resolves a type reference to its declaration', () => {
  const at = pos(MINIMAL, 8, 'UserId', 2);
  const defs = definition(MINIMAL, at.line, at.character, 'file:///demo.arc');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].range.start.line, 3); // the type UserId declaration line
});

test('definition resolves an operation declaration', () => {
  const at = pos(MINIMAL, 8, 'get', 1);
  const defs = definition(MINIMAL, at.line, at.character, 'file:///demo.arc');
  assert.equal(defs.length, 1);
  assert.equal(MINIMAL.split('\n')[defs[0].range.start.line].includes('public op get'), true);
});

test('references include the declaration and its uses', () => {
  const line = chat.split('\n').findIndex((l) => l.includes('public op send'));
  const at = pos(chat, line, 'send', 1);
  const refs = references(chat, at.line, at.character, 'file:///chat/main.arc');
  assert.ok(refs.length >= 2, 'expected declaration + at least one use, got ' + refs.length);
});

test('hover returns the declaration source line', () => {
  const at = pos(MINIMAL, 3, 'UserId', 1);
  const h = hover(MINIMAL, at.line, at.character);
  assert.ok(h, 'hover is not null');
  assert.match(h!.contents.value, /UserId/);
});

test('formatting canonicalizes and is idempotent', () => {
  const edits = formatting(MINIMAL, 'demo.arc');
  const formatted = edits.length === 1 ? edits[0].newText : MINIMAL;
  const again = formatting(formatted, 'demo.arc');
  assert.deepEqual(again, [], 'formatting a canonical spec is a no-op');
});

// Saga steps and workflow steps call declared operations; "find references" is
// only useful in the editor if those calls resolve like any other use.
test('references follow a saga step back to the operation it calls', async () => {
  const saga = await readFile(new URL('../examples/saga/main.arc', import.meta.url), 'utf8');
  const lines = saga.split('\n');
  const line = lines.findIndex((l) => l.includes('step mark'));
  assert.notEqual(line, -1, 'the saga example still declares the mark step');

  const refs = references(saga, line, lines[line].indexOf('mark'), 'file:///saga/main.arc');
  assert.ok(refs.length >= 2, 'the step and the op it calls both answer, got ' + refs.length);
  assert.ok(
    refs.some((r) => r.range.start.line === line),
    'the step declaration is one of the references',
  );
  assert.ok(
    refs.some((r) => /op mark\b/.test(lines[r.range.start.line])),
    'the operation declaration is one of the references',
  );
});

// A workflow with two steps: `render` depends on `prepare` and both call the
// same operation, so the two kinds of reference can be told apart.
const WORKFLOW = [
  'module nightly @0.1.0 {',
  '  meta { owner: "@you" }',
  '}',
  '',
  'type Snapshot = { id: string }',
  '',
  'service Reports : http {',
  '  contract {',
  '    public op prepare() -> Snapshot { route: "POST /v1/prepare" }',
  '  }',
  '}',
  '',
  'workflow Nightly {',
  '  trigger cron("0 3 * * *")',
  '  step prepare() -> Snapshot {',
  '    call: Reports.prepare',
  '  }',
  '  step render(snapshot: Snapshot) -> Snapshot {',
  '    call: Reports.prepare',
  '    needs: prepare',
  '  }',
  '}',
].join('\n');

test('references follow a workflow step call to the operation', () => {
  const spec = WORKFLOW;
  const lines = spec.split('\n');

  // A `call:` is an op reference: the op declaration and every call site.
  const callLine = lines.findIndex((l) => l.includes('call: Reports.prepare'));
  const callRefs = references(spec, callLine, lines[callLine].indexOf('prepare'), 'file:///nightly.arc');
  assert.ok(callRefs.length >= 2, 'the workflow call and the op declaration answer, got ' + callRefs.length);
  assert.ok(
    callRefs.some((r) => /public op prepare/.test(lines[r.range.start.line])),
    'the operation declaration is one of the references',
  );

  // A `needs:` is a step reference, in the workflow's own scope. It used to be
  // indexed as an op reference, so find-references on the step hid its users.
  const stepLine = lines.findIndex((l) => l.trimStart().startsWith('step prepare'));
  const stepRefs = references(spec, stepLine, lines[stepLine].indexOf('prepare'), 'file:///nightly.arc');
  const ranged = stepRefs.map((r) => r.range.start.line + ':' + r.range.start.character);
  assert.ok(
    stepRefs.some((r) => r.range.start.line === stepLine && r.range.start.character === lines[stepLine].indexOf('prepare')),
    'the step declaration itself is included: ' + JSON.stringify(ranged),
  );
  const needsLine = lines.findIndex((l) => l.trimStart().startsWith('needs:'));
  assert.ok(
    stepRefs.some((r) => r.range.start.line === needsLine && r.range.start.character === lines[needsLine].indexOf('prepare')),
    'the needs clause points at the step, at the right column: ' + JSON.stringify(ranged),
  );
});

test('document symbols nest workflow steps under the workflow', () => {
  const symbols = documentSymbols(WORKFLOW);
  const workflow = symbols[0].children?.find((s) => s.name === 'Nightly');
  assert.ok(workflow, 'the workflow appears in the outline: ' + JSON.stringify(symbols[0].children?.map((s) => s.name)));
  assert.deepEqual(
    workflow.children?.map((s) => s.name),
    ['prepare', 'render'],
    'steps are the workflow children, in source order',
  );
});

test('formatting a broken spec returns no edits instead of throwing', () => {
  const broken = ['module broken @0.1.0 {', '  meta {', ''].join('\n');
  assert.deepEqual(formatting(broken, 'broken.arc'), [], 'a half-written spec formats to nothing');
  assert.deepEqual(formatting('@@@ not arcod at all', 'broken.arc'), [], 'a lexer failure is not a crash');
});

test('formatting keeps a comment inside a ui block, not at the end of the file', () => {
  const src = [
    'module demo @0.1.0 {}',
    'ui Board {',
    '  kind: spa',
    '  route: "/board"',
    '  // dark by default',
    '  theme: dark',
    '}',
  ].join('\n');
  const edits = formatting(src, 'demo.arc');
  assert.equal(edits.length, 1, 'the whole document is replaced');
  const out = edits[0].newText;
  assert.match(out, /^  \/\/ dark by default\n  theme: dark$/m);
  assert.deepEqual(formatting(out, 'demo.arc'), [], 'a second format is a no-op');
});

