// LSP feature core: everything the language server answers is a pure function of
// (source text, position). It reuses the real lexer/parser/check/fmt — no regex
// duplication — so the editor sees exactly what the compiler sees.
//
// Positions are LSP 0-based; the compiler's Loc is 1-based, so conversion happens
// here and nowhere else.

import type { Diagnostic } from './diagnostics.ts';
import { check } from './check.ts';
import { LexError } from './lexer.ts';
import { parse, ParseError } from './parser.ts';
import { formatSource } from './fmt.ts';
import type {
  Expr, Loc, ModuleNode, OpNode, TypeExpr,
} from './ast.ts';

export interface LspPosition { line: number; character: number; }
export interface LspRange { start: LspPosition; end: LspPosition; }
export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  code: string;
  source: string;
  message: string;
}
export interface LspLocation { uri: string; range: LspRange; }
export interface LspTextEdit { range: LspRange; newText: string; }
export interface LspCompletionItem {
  label: string;
  kind: number;
  detail?: string;
  sortText?: string;
  insertText?: string;
}
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
export interface LspHover {
  contents: { kind: 'markdown' | 'plaintext'; value: string };
  range?: LspRange;
}

// CompletionItemKind (LSP 3.17) — the subset Arcod uses.
export const CompletionKind = {
  Text: 1, Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7,
  Interface: 8, Module: 9, Property: 10, Value: 12, Enum: 13, Keyword: 14,
  EnumMember: 20, Constant: 21, Struct: 22,
} as const;

// SymbolKind (LSP 3.17).
export const SymbolKind = {
  Module: 2, Class: 5, Method: 6, Field: 8, Enum: 10, Interface: 11,
  Function: 12, Variable: 13, Constant: 14, Object: 19, Struct: 23, Event: 24,
} as const;

export const Severity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;

// The valid v0.1 keyword surface. Dead keywords (policy, change, hint, impl,
// lifecycle, unknown, idempotent, schedule, since) are intentionally absent:
// the parser rejects them with "not supported in v0.1", so offering them would
// auto-complete a parse error.
const KEYWORDS: Array<[string, string]> = [
  ['module', 'модуль и версия языка'],
  ['service', 'сервис'],
  ['op', 'операция'],
  ['job', 'задача (queue/saga-консьюмер)'],
  ['public', 'публичная операция'],
  ['auth', 'операция требует аутентификации'],
  ['route', 'HTTP-маршрут операции'],
  ['errors', 'ошибки операции'],
  ['params', 'параметры операции'],
  ['returns', 'возвращаемый тип'],
  ['uses', 'используемые возможности'],
  ['type', 'объявление типа'],
  ['enum', 'перечисление'],
  ['error', 'объявление ошибки'],
  ['environment', 'окружение'],
  ['workflow', 'воркфлоу'],
  ['saga', 'сага с компенсацией'],
  ['step', 'шаг саги/воркфлоу'],
  ['compensate', 'компенсирующая операция шага'],
  ['retry', 'число повторов'],
  ['call', 'вызываемая операция шага'],
  ['when', 'условие'],
  ['then', 'ожидаемый результат'],
  ['given', 'предусловие примера'],
  ['pre', 'предусловие'],
  ['post', 'постусловие'],
  ['timeout', 'таймаут'],
  ['meta', 'метаданные модуля'],
  ['effects', 'используемые эффекты'],
  ['allow', 'разрешённые роли'],
  ['deny', 'запрещённые роли'],
  ['roles', 'роли операции'],
  ['budget', 'бюджет операции'],
  ['ui', 'интерфейс'],
  ['deploy', 'провайдер развёртывания'],
  ['bind', 'привязка провайдера'],
  ['invariant', 'инвариант'],
  ['atomic', 'атомарный шаг'],
  ['true', 'истина'],
  ['false', 'ложь'],
  ['null', 'пусто'],
];

interface Doc {
  text: string;
  mod: ModuleNode | null;
  file: string;
}

function toLspRange(loc: Loc): LspRange {
  return {
    start: { line: loc.line - 1, character: loc.col - 1 },
    end: { line: loc.endLine - 1, character: loc.endCol - 1 },
  };
}

function parseDoc(text: string, file: string): Doc {
  try {
    return { text, mod: parse(text, file), file };
  } catch {
    return { text, mod: null, file };
  }
}

function lineOffsets(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') out.push(i + 1);
  }
  return out;
}

function offsetAt(text: string, line: number, character: number): number {
  const offsets = lineOffsets(text);
  const start = offsets[Math.min(line, offsets.length - 1)] ?? 0;
  return Math.min(start + character, text.length);
}

function fullRange(text: string): LspRange {
  const lines = text.split('\n');
  return {
    start: { line: 0, character: 0 },
    end: { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1].length },
  };
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;

function wordAt(text: string, line: number, character: number): { word: string; start: LspPosition; end: LspPosition } | null {
  const offsets = lineOffsets(text);
  if (line < 0 || line >= offsets.length) return null;
  const lineText = text.slice(offsets[line], line === offsets.length - 1 ? text.length : offsets[line + 1]);
  const col = Math.min(character, lineText.length);
  let s = col;
  while (s > 0 && IDENT.test(lineText[s - 1])) s--;
  let e = col;
  while (e < lineText.length && IDENT.test(lineText[e])) e++;
  if (s === e) return null;
  return {
    word: lineText.slice(s, e),
    start: { line, character: s },
    end: { line, character: e },
  };
}

// The identifier that precedes the cursor word as an owner, e.g. the 'Reports'
// in 'Reports.prepare'. Used to resolve qualified names.
function qualifiedOwner(text: string, line: number, character: number): string | null {
  const offsets = lineOffsets(text);
  if (line < 0 || line >= offsets.length) return null;
  const lineText = text.slice(offsets[line], line === offsets.length - 1 ? text.length : offsets[line + 1]);
  const col = Math.min(character, lineText.length);
  let s = col;
  while (s > 0 && IDENT.test(lineText[s - 1])) s--;
  if (s > 0 && lineText[s - 1] === '.') {
    let t = s - 2;
    while (t >= 0 && IDENT.test(lineText[t])) t--;
    const owner = lineText.slice(t + 1, s - 1);
    return owner || null;
  }
  return null;
}

// ---------------------------------------------------------------- symbols ---

interface SymbolDef {
  name: string;
  kind: string; // module|type|error|enum|service|op|job|saga|alias|param|workflow|step|ui|environment|bind
  container: string | null;
  owner: string | null;
  loc: Loc;
  detail: string;
}

interface SymbolRef {
  name: string;
  kind: string;
  container: string | null;
  owner: string | null;
  loc: Loc;
}

// The declaration source line (up to 120 chars) — used as hover text and
// completion detail.
function sourceLine(mod: ModuleNode, loc: Loc): string {
  const start = loc.offset;
  let end = mod.source.indexOf('\n', start);
  if (end === -1) end = mod.source.length;
  const line = mod.source.slice(start, end).trim();
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
}

// Tight range for a name inside a declaration: search the declaration's first
// line for the identifier, falling back to the whole declaration loc.
function nameLoc(mod: ModuleNode, declLoc: Loc, name: string): Loc {
  const lineEnd = mod.source.indexOf('\n', declLoc.offset);
  const windowEnd = lineEnd === -1 ? mod.source.length : lineEnd;
  const idx = mod.source.indexOf(name, declLoc.offset);
  if (idx !== -1 && idx + name.length <= windowEnd) {
    const d = idx - declLoc.offset;
    return {
      line: declLoc.line,
      col: declLoc.col + d,
      endLine: declLoc.line,
      endCol: declLoc.col + d + name.length,
      offset: idx,
      end: idx + name.length,
    };
  }
  return declLoc;
}

// Tight range for a (possibly qualified) op reference inside a containing
// block: find 'call' in the source window and point at just the op name.
function locForCall(mod: ModuleNode, call: string, block: Loc): Loc {
  const dot = call.lastIndexOf('.');
  const name = dot >= 0 ? call.slice(dot + 1) : call;
  const idx = mod.source.indexOf(call, block.offset);
  if (idx !== -1 && idx < block.end) {
    const nameIdx = idx + (call.length - name.length);
    const before = mod.source.slice(0, nameIdx);
    const line = before.split('\n').length;
    const lineStart = mod.source.lastIndexOf('\n', nameIdx - 1) + 1;
    const col = nameIdx - lineStart + 1;
    return { line, col, endLine: line, endCol: col + name.length, offset: nameIdx, end: nameIdx + name.length };
  }
  return block;
}

function walkType(t: TypeExpr, fn: (t: TypeExpr) => void): void {
  fn(t);
  switch (t.kind) {
    case 'optional': walkType(t.inner, fn); break;
    case 'union': for (const v of t.variants) walkType(v, fn); break;
    case 'record': for (const f of t.fields) walkType(f.type, fn); break;
    case 'named':
      for (const a of t.args) if (a.isType) walkType(a.value as TypeExpr, fn);
      break;
  }
}

function walkExpr(expr: Expr, fn: (e: Expr) => void): void {
  fn(expr);
  switch (expr.kind) {
    case 'member': walkExpr(expr.object, fn); break;
    case 'call':
      walkExpr(expr.callee, fn);
      for (const a of expr.args) walkExpr(a.value, fn);
      break;
    case 'unary': walkExpr(expr.operand, fn); break;
    case 'binary': walkExpr(expr.left, fn); walkExpr(expr.right, fn); break;
    case 'is': walkExpr(expr.expr, fn); break;
    default: break;
  }
}

function index(mod: ModuleNode): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const defs: SymbolDef[] = [];
  const refs: SymbolRef[] = [];
  const addDef = (name: string, kind: string, container: string | null, owner: string | null, loc: Loc) => {
    defs.push({ name, kind, container, owner, loc: nameLoc(mod, loc, name), detail: sourceLine(mod, loc) });
  };
  const addRef = (name: string, kind: string, container: string | null, owner: string | null, loc: Loc) => {
    refs.push({ name, kind, container, owner, loc });
  };
  // A saga/workflow 'call' may be 'op' or 'Service.op'.
  const addCallRef = (call: string, self: string | null, block: Loc) => {
    const loc = locForCall(mod, call, block);
    const dot = call.indexOf('.');
    if (dot > 0) addRef(call.slice(dot + 1), 'op', call.slice(0, dot), null, loc);
    else addRef(call, 'op', self, null, loc);
  };

  addDef(mod.name, 'module', null, null, mod.loc);
  for (const t of mod.types) addDef(t.name, 'type', null, null, t.loc);
  for (const e of mod.errors) addDef(e.name, 'error', null, null, e.loc);
  for (const en of mod.enums) addDef(en.name, 'enum', null, null, en.loc);
  for (const w of mod.workflows) addDef(w.name, 'workflow', null, null, w.loc);
  for (const u of mod.uis) addDef(u.name, 'ui', null, null, u.loc);
  for (const env of mod.environments) addDef(env.name, 'environment', null, null, env.loc);

  for (const svc of mod.services) {
    addDef(svc.name, 'service', null, null, svc.loc);
    for (const use of svc.uses) addDef(use.alias, 'alias', svc.name, null, use.loc);
    for (const op of svc.contract) {
      addDef(op.name, op.kind, svc.name, null, op.loc);
      for (const p of op.params) addDef(p.name, 'param', svc.name, op.name, p.loc);
    }
    for (const saga of svc.sagas) {
      addDef(saga.name, 'saga', svc.name, null, saga.loc);
      for (const step of saga.steps) {
        if (step.call) addCallRef(step.call, svc.name, step.loc);
        if (step.compensate) addCallRef(step.compensate, svc.name, step.loc);
      }
    }
    for (const rule of svc.rules) {
      if (rule.kind === 'invariant') walkExpr(rule.expr, (e) => collectExprRefs(e, svc.name, null, addRef));
      if (rule.kind === 'atomic') for (const name of rule.steps) addCallRef(name, svc.name, rule.loc);
    }
    for (const example of svc.examples) {
      for (const s of example.given) collectStmtRefs(s, svc.name, null, addRef);
      for (const s of example.when) collectStmtRefs(s, svc.name, null, addRef);
      for (const s of example.then) collectStmtRefs(s, svc.name, null, addRef);
    }
    for (const op of svc.contract) collectOpRefs(op, svc.name, addRef);
  }

  for (const w of mod.workflows) {
    for (const step of w.steps) {
      addDef(step.name, 'step', w.name, null, step.loc);
      if (step.call) addCallRef(step.call, null, step.loc);
      for (const need of step.needs) addCallRef(need, null, step.loc);
    }
  }

  for (const env of mod.environments) {
    for (const b of env.binds) addDef(b.alias, 'bind', env.name, null, b.loc);
  }

  // UI operation bindings: every op name a page wires up is a reference.
  for (const u of mod.uis) {
    for (const use of u.uses) addCallRef(use, null, u.loc);
    if (u.history) addCallRef(u.history, null, u.loc);
    if (u.send) addCallRef(u.send, null, u.loc);
    if (u.start) addCallRef(u.start, null, u.loc);
    if (u.join) addCallRef(u.join, null, u.loc);
    if (u.state) addCallRef(u.state, null, u.loc);
    if (u.advance) addCallRef(u.advance, null, u.loc);
  }

  // Named-type references, everywhere a TypeExpr can appear.
  for (const t of mod.types) walkType(t.type, (n) => { if (n.kind === 'named') addRef(n.name, 'type', null, null, n.loc); });
  for (const svc of mod.services) {
    for (const op of svc.contract) {
      for (const p of op.params) walkType(p.type, (n) => { if (n.kind === 'named') addRef(n.name, 'type', null, null, n.loc); });
      if (op.returns) walkType(op.returns, (n) => { if (n.kind === 'named') addRef(n.name, 'type', null, null, n.loc); });
    }
  }

  return { defs, refs };
}

function collectOpRefs(op: OpNode, svcName: string, addRef: (n: string, k: string, c: string | null, o: string | null, l: Loc) => void): void {
  for (const clause of op.clauses) {
    if (clause.kind === 'errors') for (const n of clause.names) addRef(n, 'error', null, null, clause.loc);
    if (clause.kind === 'onerror') addRef(clause.error, 'error', null, null, clause.loc);
    if (clause.kind === 'pre' || clause.kind === 'post') collectExprRefs(clause.expr, svcName, op.name, addRef);
  }
}

function collectStmtRefs(stmt: { kind: string; name?: string; expr: Expr; loc: Loc }, svcName: string, owner: string | null, addRef: (n: string, k: string, c: string | null, o: string | null, l: Loc) => void): void {
  collectExprRefs(stmt.expr, svcName, owner, addRef);
}

function collectExprRefs(expr: Expr, svcName: string, owner: string | null, addRef: (n: string, k: string, c: string | null, o: string | null, l: Loc) => void): void {
  walkExpr(expr, (e) => {
    if (e.kind === 'ident') {
      addRef(e.name, 'ident', svcName, owner, e.loc);
    } else if (e.kind === 'member') {
      if (e.object.kind === 'ident') addRef(e.object.name, 'alias', svcName, owner, e.object.loc);
    } else if (e.kind === 'call' && e.callee.kind === 'ident') {
      addRef(e.callee.name, 'op', svcName, owner, e.callee.loc);
    }
  });
}

// -------------------------------------------------------------- diagnostics --

export function diagnostics(text: string, file: string): LspDiagnostic[] {
  try {
    const mod = parse(text, file);
    return check(mod).map(toLsp);
  } catch (error) {
    if (error instanceof ParseError) {
      return [{
        range: toLspRange(error.loc),
        severity: Severity.Error,
        code: 'parse',
        source: 'arcod',
        message: error.message,
      }];
    }
    if (error instanceof LexError) {
      return [{
        range: { start: { line: error.line - 1, character: error.col - 1 }, end: { line: error.line - 1, character: error.col } },
        severity: Severity.Error,
        code: 'lex',
        source: 'arcod',
        message: error.message,
      }];
    }
    return [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: Severity.Error,
      code: 'internal',
      source: 'arcod',
      message: String(error),
    }];
  }
}

function toLsp(d: Diagnostic): LspDiagnostic {
  return {
    range: {
      start: { line: d.range.line - 1, character: d.range.col - 1 },
      end: { line: d.range.endLine - 1, character: d.range.endCol - 1 },
    },
    severity: d.severity === 'error' ? Severity.Error : Severity.Warning,
    code: d.code,
    source: 'arcod',
    message: d.hint ? d.message + ' — ' + d.hint : d.message,
  };
}

// -------------------------------------------------------------- completion --

export function completions(text: string, line: number, character: number): LspCompletionItem[] {
  const doc = parseDoc(text, 'document.arc');
  const items: LspCompletionItem[] = [];
  const at = wordAt(text, line, character);
  const prefix = (at?.word ?? '').toLowerCase();

  for (const [kw, detail] of KEYWORDS) {
    if (prefix === '' || kw.startsWith(prefix)) {
      items.push({ label: kw, kind: CompletionKind.Keyword, detail, sortText: '1' + kw, insertText: kw });
    }
  }

  if (doc.mod) {
    for (const d of index(doc.mod).defs) {
      if (prefix !== '' && !d.name.toLowerCase().startsWith(prefix)) continue;
      const kind = defKind(d);
      if (kind === null) continue;
      items.push({ label: d.name, kind, detail: d.detail, sortText: '2' + d.kind + d.name, insertText: d.name });
    }
  }

  return dedupe(items);
}

function dedupe(items: LspCompletionItem[]): LspCompletionItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.label)) return false;
    seen.add(i.label);
    return true;
  });
}

function defKind(d: SymbolDef): number | null {
  switch (d.kind) {
    case 'module': return SymbolKind.Module;
    case 'type': return SymbolKind.Struct;
    case 'error': return SymbolKind.Event;
    case 'enum': return SymbolKind.Enum;
    case 'service': return SymbolKind.Class;
    case 'op': return SymbolKind.Method;
    case 'job': return SymbolKind.Function;
    case 'saga': return SymbolKind.Function;
    case 'alias': return SymbolKind.Variable;
    case 'param': return SymbolKind.Field;
    case 'workflow': return SymbolKind.Function;
    case 'step': return SymbolKind.Method;
    case 'ui': return SymbolKind.Interface;
    case 'environment': return SymbolKind.Constant;
    case 'bind': return SymbolKind.Variable;
    default: return null;
  }
}

// ------------------------------------------------------------ symbols tree --

export function documentSymbols(text: string): LspDocumentSymbol[] {
  const doc = parseDoc(text, 'document.arc');
  if (!doc.mod) return [];
  const mod = doc.mod;
  const defs = index(mod).defs;
  const find = (name: string, kind: string): SymbolDef | undefined => defs.find((d) => d.name === name && d.kind === kind);
  const leaf = (name: string, kind: string, symbolKind: number): LspDocumentSymbol | null => {
    const d = find(name, kind);
    if (!d) return null;
    return { name, kind: symbolKind, range: toLspRange(d.loc), selectionRange: toLspRange(d.loc), detail: d.detail };
  };

  if (!mod.name) return [];
  const module: LspDocumentSymbol = {
    name: mod.name,
    kind: SymbolKind.Module,
    range: toLspRange(mod.loc),
    selectionRange: toLspRange(mod.loc),
    children: [],
  };
  for (const t of mod.types) { const s = leaf(t.name, 'type', SymbolKind.Struct); if (s) module.children!.push(s); }
  for (const e of mod.errors) { const s = leaf(e.name, 'error', SymbolKind.Event); if (s) module.children!.push(s); }
  for (const en of mod.enums) { const s = leaf(en.name, 'enum', SymbolKind.Enum); if (s) module.children!.push(s); }
  for (const svc of mod.services) {
    const s = leaf(svc.name, 'service', SymbolKind.Class);
    if (s) {
      s.children = [];
      for (const op of svc.contract) {
        const o = leaf(op.name, op.kind, op.kind === 'op' ? SymbolKind.Method : SymbolKind.Function);
        if (o) s.children!.push(o);
      }
      for (const saga of svc.sagas) { const g = leaf(saga.name, 'saga', SymbolKind.Function); if (g) s.children!.push(g); }
      module.children!.push(s);
    }
  }
  for (const w of mod.workflows) {
    const s = leaf(w.name, 'workflow', SymbolKind.Function);
    if (s) {
      s.children = [];
      for (const step of w.steps) { const st = leaf(step.name, 'step', SymbolKind.Method); if (st) s.children!.push(st); }
      module.children!.push(s);
    }
  }
  for (const u of mod.uis) { const s = leaf(u.name, 'ui', SymbolKind.Interface); if (s) module.children!.push(s); }
  for (const env of mod.environments) { const s = leaf(env.name, 'environment', SymbolKind.Constant); if (s) module.children!.push(s); }
  return [module];
}

// ----------------------------------------------------- definition/references --

function containerAt(mod: ModuleNode, offset: number): string | null {
  for (const svc of mod.services) if (offset >= svc.loc.offset && offset <= svc.loc.end) return svc.name;
  for (const w of mod.workflows) if (offset >= w.loc.offset && offset <= w.loc.end) return w.name;
  return null;
}

function resolveDef(mod: ModuleNode, text: string, line: number, character: number): SymbolDef | null {
  const { defs } = index(mod);
  const at = wordAt(text, line, character);
  if (!at) return null;
  const offset = offsetAt(text, line, character);
  const container = containerAt(mod, offset);
  const owner = qualifiedOwner(text, line, character);
  const name = at.word;

  const matches = defs.filter((d) => d.name === name);
  if (matches.length === 0) return null;
  if (owner) {
    const owned = matches.filter((d) => d.container === owner);
    if (owned.length > 0) return owned[0];
  }
  if (container) {
    const scoped = matches.filter((d) => d.container === container);
    if (scoped.length > 0) return scoped[0];
  }
  return matches[0];
}

export function definition(text: string, line: number, character: number, uri: string): LspLocation[] {
  const doc = parseDoc(text, 'document.arc');
  if (!doc.mod) return [];
  const def = resolveDef(doc.mod, text, line, character);
  if (!def) return [];
  return [{ uri, range: toLspRange(def.loc) }];
}

export function references(text: string, line: number, character: number, uri: string): LspLocation[] {
  const doc = parseDoc(text, 'document.arc');
  if (!doc.mod) return [];
  const { refs } = index(doc.mod);
  const def = resolveDef(doc.mod, text, line, character);
  if (!def) return [];
  const out: LspLocation[] = [{ uri, range: toLspRange(def.loc) }];

  const sameScope = (r: SymbolRef): boolean => {
    if (r.name !== def.name) return false;
    if (def.container === null) return true;
    if (r.container !== def.container) return false;
    if (def.owner !== null && r.owner !== null && r.owner !== def.owner) return false;
    return true;
  };

  for (const r of refs) if (sameScope(r)) out.push({ uri, range: toLspRange(r.loc) });
  return out;
}

export function hover(text: string, line: number, character: number): LspHover | null {
  const doc = parseDoc(text, 'document.arc');
  if (!doc.mod) return null;
  const def = resolveDef(doc.mod, text, line, character);
  if (!def) return null;
  return {
    contents: { kind: 'plaintext', value: def.kind + ' ' + def.name + '\n' + def.detail },
    range: toLspRange(def.loc),
  };
}

// --------------------------------------------------------------- formatting --

export function formatting(text: string, file: string): LspTextEdit[] {
  try {
    const formatted = formatSource(text, file);
    if (formatted === text) return [];
    return [{ range: fullRange(text), newText: formatted }];
  } catch {
    return [];
  }
}
