import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  completions, definition, documentSymbols, hover, references,
  CompletionKind, SymbolKind,
} from '../src/lsp.ts';

const quiz = await readFile(new URL('../examples/quiz/main.arc', import.meta.url), 'utf8');
const saga = await readFile(new URL('../examples/saga/main.arc', import.meta.url), 'utf8');

// A spec that exercises type shapes the examples do not: a union of a record
// and a page, a list<T> and an optional T?, plus two ops that share a
// parameter name and one unary pre: condition.
const TYPES = [
  'module demo @0.1.0 {',
  '}',
  '',
  'type TaskId = uuid',
  'type Task = { id: TaskId, title: string }',
  'type Page = { items: list<Task>, next: Task? }',
  'type Result = Task | Page',
  '',
  'service Api : http {',
  '  contract {',
  '    public op first(id: TaskId, flag: bool) -> Result {',
  '      route: "GET /v1/first"',
  '      pre: !flag',
  '      post: id != null',
  '    }',
  '',
  '    public op second(id: TaskId) -> Result {',
  '      route: "GET /v1/second"',
  '      post: id != null',
  '    }',
  '  }',
  '}',
].join('\n');

function lineWith(text: string, needle: string): number {
  const idx = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(idx >= 0, 'no line with ' + needle);
  return idx;
}

function spotsOf(text: string, line: number, character: number): string[] {
  return references(text, line, character, 'file:///demo.arc').map(
    (r) => r.range.start.line + ':' + r.range.start.character,
  );
}

test('a ui page binds state/join/advance to the operations it wires', () => {
  const lines = quiz.split('\n');
  const stateLine = lineWith(quiz, 'state: Live.state');
  const at = lines[stateLine].indexOf('state');
  const opLine = lineWith(quiz, 'op state(');
  const spots = spotsOf(quiz, stateLine, at);
  const afterDot = lines[stateLine].indexOf('Live.state') + 'Live.'.length;
  assert.ok(spots.includes(stateLine + ':' + afterDot), 'the ui binding is a use of the op: ' + spots);
  assert.ok(spots.includes(opLine + ':' + lines[opLine].indexOf('state')), 'and the declaration: ' + spots);
  assert.equal(new Set(spots).size, spots.length, 'no position is listed twice: ' + spots);
});

test('find-references keeps same-named parameters of different ops apart', () => {
  const lines = TYPES.split('\n');
  const opFirst = lineWith(TYPES, 'op first(');
  const posts = lines.map((l, i) => (l.trim() === 'post: id != null' ? i : -1)).filter((i) => i >= 0);
  assert.equal(posts.length, 2, 'two ops declare the same parameter');
  const spots = spotsOf(TYPES, posts[0], lines[posts[0]].indexOf('id'));
  assert.ok(spots.includes(opFirst + ':' + lines[opFirst].indexOf('id')), 'the parameter declaration: ' + spots);
  assert.ok(spots.includes(posts[0] + ':' + lines[posts[0]].indexOf('id')), 'the first op use: ' + spots);
  assert.equal(
    spots.some((s) => s.startsWith(posts[1] + ':')),
    false,
    'the second op has its own id, not this one: ' + spots,
  );
});

test('references walk union variants, list<T> arguments and optional types', () => {
  const lines = TYPES.split('\n');
  const taskLine = lineWith(TYPES, 'type Task =');
  const pageLine = lineWith(TYPES, 'type Page =');
  const resultLine = lineWith(TYPES, 'type Result =');
  const spots = spotsOf(TYPES, taskLine, lines[taskLine].indexOf('Task'));
  assert.ok(
    spots.includes(pageLine + ':' + (lines[pageLine].indexOf('list<Task>') + 'list<'.length)),
    'the list<Task> argument: ' + spots,
  );
  assert.ok(
    spots.includes(pageLine + ':' + lines[pageLine].indexOf('Task?')),
    'the optional Task?: ' + spots,
  );
  assert.ok(
    spots.includes(resultLine + ':' + lines[resultLine].indexOf('Task')),
    'the union variant: ' + spots,
  );
  const defs = definition(TYPES, resultLine, lines[resultLine].indexOf('Page'), 'file:///demo.arc');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].range.start.line, pageLine, 'a union variant resolves to its declaration');
});

test('a unary expression in pre: is walked for references', () => {
  const lines = TYPES.split('\n');
  const opLine = lineWith(TYPES, 'op first(');
  const preLine = lineWith(TYPES, 'pre: !flag');
  const spots = spotsOf(TYPES, opLine, lines[opLine].indexOf('flag'));
  assert.ok(
    spots.includes(preLine + ':' + lines[preLine].indexOf('flag')),
    'the operand under ! is a use: ' + spots,
  );
});

test('completions list a name once when two declarations share it', () => {
  const dup = 'module demo @0.1.0 {\n}\n\ntype demo = string\n';
  const labels = completions(dup, 1, 0).map((i) => i.label);
  assert.equal(labels.filter((l) => l === 'demo').length, 1, 'one demo, not two: ' + labels.join(','));
  const demo = completions(dup, 1, 0).find((i) => i.label === 'demo')!;
  assert.equal(demo.kind, SymbolKind.Module, 'the module declaration wins, it comes first');
});

test('out-of-range positions answer empty instead of throwing', () => {
  const above = completions(TYPES, -3, -1).map((i) => i.label);
  assert.ok(above.includes('service'), 'a negative line still completes at the top: ' + above.join(','));
  const beyond = completions(TYPES, 10_000, 0).map((i) => i.label);
  assert.ok(beyond.includes('service'), 'a line past EOF completes too: ' + beyond.join(','));
  assert.deepEqual(definition(TYPES, -3, 0, 'file:///demo.arc'), []);
  assert.deepEqual(definition(TYPES, 10_000, 0, 'file:///demo.arc'), []);
  assert.deepEqual(references(TYPES, 10_000, 0, 'file:///demo.arc'), []);
  assert.equal(hover(TYPES, 10_000, 0), null);
});

test('a document that does not parse has no symbols, hover, definition or references', () => {
  const broken = 'module broken @0.1.0 {\n  meta {\n';
  assert.deepEqual(documentSymbols(broken), []);
  assert.equal(hover(broken, 0, 1), null);
  assert.deepEqual(definition(broken, 0, 1, 'file:///broken.arc'), []);
  assert.deepEqual(references(broken, 0, 1, 'file:///broken.arc'), []);
});

test('hover truncates a long declaration line and keeps a short one whole', () => {
  const fields = Array.from({ length: 12 }, (_, i) => 'f' + i + ': string').join(', ');
  const long = ['module demo @0.1.0 {', '}', '', 'type Wide = { ' + fields + ' }'].join('\n');
  const wideLine = lineWith(long, 'type Wide');
  assert.ok(long.split('\n')[wideLine].length > 120, 'the declaration line is long enough to cut');
  const wide = hover(long, wideLine, long.split('\n')[wideLine].indexOf('Wide'))!;
  const detail = wide.contents.value.split('\n')[1];
  assert.equal(detail.length, 118, 'cut to 117 characters plus one ellipsis: ' + detail);
  assert.ok(detail.endsWith('\u2026'), 'the cut is marked: ' + detail);

  // No trailing newline: the declaration line runs to the end of the source.
  const tail = 'module demo @0.1.0 {\n}\n\ntype Tail = string';
  const tailLine = lineWith(tail, 'type Tail');
  const tailHover = hover(tail, tailLine, tail.split('\n')[tailLine].indexOf('Tail'))!;
  assert.equal(tailHover.contents.value, 'type Tail\ntype Tail = string');
});

test('completions label jobs, sagas, steps, ui pages and environment binds', () => {
  const lines = saga.split('\n');
  const blank = lines.findIndex((l) => l.trim() === '');
  assert.ok(blank >= 0);
  const items = completions(saga, blank, 0);
  // Declared symbols carry LSP SymbolKind numbers in completions, the same
  // numbers documentSymbols reports: one mapping for both surfaces.
  const kind = (label: string) => items.find((i) => i.label === label)?.kind;
  assert.equal(kind('Checkout'), SymbolKind.Class);
  assert.equal(kind('Marker'), SymbolKind.Struct);
  assert.equal(kind('Invalid'), SymbolKind.Event);
  assert.equal(kind('run_checkout'), SymbolKind.Function, 'a job is a function');
  assert.equal(kind('checkout'), SymbolKind.Function, 'a saga is a function');

  const quizLines = quiz.split('\n');
  const quizItems = completions(quiz, quizLines.findIndex((l) => l.trim() === ''), 0);
  assert.equal(quizItems.find((i) => i.label === 'Stage')?.kind, SymbolKind.Interface);
  assert.equal(quizItems.find((i) => i.label === 'dev')?.kind, SymbolKind.Constant);

  const symbols = documentSymbols(quiz)[0].children!;
  const stage = symbols.find((s) => s.name === 'Stage');
  assert.equal(stage?.kind, SymbolKind.Interface, 'a ui page is in the outline');
  assert.equal(symbols.find((s) => s.name === 'dev')?.kind, SymbolKind.Constant, 'an environment too');
  assert.equal(quizItems.find((i) => i.label === 'store')?.kind, SymbolKind.Variable, 'a bind completes as a variable');
});

test('the outline lists a page by its slides and an environment by its binds', () => {
  const symbols = documentSymbols(quiz)[0].children!;
  const stage = symbols.find((s) => s.name === 'Stage')!;
  assert.deepEqual(
    stage.children?.map((s) => s.name),
    ['Who are you?', 'Join', 'Agenda', 'Questions'],
    'slides are the page children, in source order',
  );
  assert.ok(stage.children!.every((s) => s.kind === SymbolKind.Object));
  const first = stage.children![0];
  assert.ok(first.range.end.line > first.range.start.line, 'a slide spans its body lines');

  const dev = symbols.find((s) => s.name === 'dev')!;
  assert.deepEqual(
    dev.children?.map((s) => s.name),
    ['store', 'uuid', 'stream'],
    'the binds are the environment children',
  );
  assert.ok(dev.children!.every((s) => s.kind === SymbolKind.Variable));
});

