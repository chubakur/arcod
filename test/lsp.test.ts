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
