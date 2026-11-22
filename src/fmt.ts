// Canonical formatter: parse -> canonical AST -> canonical source.
// fmt is a pure function of the AST, so it is idempotent and round-trips the
// model exactly (parse(print(x)) === x structurally). Comments are re-attached
// to the declaration, field, enum value or example statement they precede (a
// commented element turns its block multi-line). A comment that trails code on
// the same line stays on that line: it is re-attached to the deepest node that
// starts there, so the printed form re-parses to the same attachment.

import type {
  Arg, BindNode, BudgetNode, CapUse, Clause, DeployNode, EffectsNode, EnvironmentNode,
  ErrorDecl, ExampleNode, Expr, Loc, ModuleNode, OpNode, Param, RuleNode, SagaNode,
  SagaStepNode, ServiceNode, Stmt, TriggerNode, TypeArg, TypeDecl, TypeExpr, UiNode,
  UiSlide, UseNode, WorkflowNode, WorkflowStepNode,
} from './ast.ts';
import { parse } from './parser.ts';

// ---------------- string helpers ----------------

function quoteStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

// ---------------- expression precedence ----------------

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

function expr(e: Expr, minPrec = 0): string {
  switch (e.kind) {
    case 'literal': {
      if (typeof e.value === 'string') {
        // A bare ISO instant (`at(2026-11-18T12:00:05Z)`) carries no quotes
        // in its raw text; quoting it would change the spec on every fmt run.
        return e.raw && !e.raw.startsWith('"') ? e.raw : quoteStr(e.value);
      }
      if (e.value === null) return 'null';
      if (typeof e.value === 'boolean') return e.value ? 'true' : 'false';
      return e.raw || String(e.value);
    }
    case 'duration': return e.value + e.unit;
    case 'list': return '[' + e.items.map((item) => expr(item)).join(', ') + ']';
    // Empty braces are printed tight: `'{ ' + '' + ' }'` would write two
    // spaces no source can produce, and a record literal with no fields is
    // otherwise a valid expression.
    case 'record': return e.fields.length === 0 ? '{}' : '{ ' + e.fields.map((field) => field.name + ': ' + expr(field.value)).join(', ') + ' }';
    case 'ident': return e.name;
    case 'member': return expr(e.object, 8) + '.' + e.property;
    case 'call': {
      // a[i] is parsed as call(member(object, '[]'), [i])
      if (e.callee.kind === 'member' && e.callee.property === '[]' && e.args.length === 1) {
        return expr(e.callee.object, 8) + '[' + expr(e.args[0].value) + ']';
      }
      const args = e.args.map((a) => (a.name ? a.name + ': ' : '') + expr(a.value)).join(', ');
      return expr(e.callee, 8) + '(' + args + ')';
    }
    case 'unary': {
      const s = e.op + expr(e.operand, 7);
      return 7 < minPrec ? '(' + s + ')' : s;
    }
    case 'binary': {
      const prec = BIN_PREC[e.op] ?? 3;
      const left = expr(e.left, prec);
      const right = expr(e.right, prec + 1);
      const s = left + ' ' + e.op + ' ' + right;
      return prec < minPrec ? '(' + s + ')' : s;
    }
    case 'is': {
      const s = expr(e.expr, 3) + ' is ' + e.error;
      return 3 < minPrec ? '(' + s + ')' : s;
    }
  }
}

// ---------------- types ----------------

function type(t: TypeExpr): string {
  switch (t.kind) {
    case 'named': {
      let s = t.name;
      const typeArgs = t.args.filter((a) => a.isType);
      const valueArgs = t.args.filter((a) => !a.isType);
      if (typeArgs.length > 0) s += '<' + typeArgs.map((a) => type(a.value as TypeExpr)).join(', ') + '>';
      if (valueArgs.length > 0) s += '(' + valueArgs.map((a) => (a.name ? a.name + ': ' : '') + expr(a.value as Expr)).join(', ') + ')';
      return s;
    }
    case 'optional': return type(t.inner) + '?';
    case 'union': return t.variants.map(type).join(' | ');
    case 'record': return t.fields.length === 0 ? '{}' : '{ ' + t.fields.map(param).join(', ') + ' }';
  }
}

function param(p: Param): string {
  let s = p.name + ': ' + type(p.type);
  if (p.default) s += ' = ' + expr(p.default);
  return s;
}

function params(ps: Param[]): string {
  return '(' + ps.map(param).join(', ') + ')';
}

// ---------------- comments ----------------

interface Comment {
  start: number;
  end: number;
  text: string;
  trailing: boolean;
}

function blockText(raw: string, column: number): string {
  const lines = raw.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      lines[i] = '';
      continue;
    }
    let cut = 0;
    while (cut < column && cut < line.length && (line[cut] === ' ' || line[cut] === '\t')) cut += 1;
    lines[i] = line.slice(cut);
  }
  return lines.join('\n');
}

function extractComments(source: string): Comment[] {
  const out: Comment[] = [];
  // A comment trails code when something other than blanks precedes it on its
  // own line; that comment belongs to the line it ends, not to the next node.
  const trailingAt = (pos: number): boolean => {
    for (let j = pos - 1; j >= 0 && source[j] !== '\n'; j--) {
      if (source[j] !== ' ' && source[j] !== '\t' && source[j] !== '\r') return true;
    }
    return false;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < source.length && source[i] !== '\n') i++;
      out.push({ start, end: i, text: source.slice(start, i), trailing: trailingAt(start) });
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, source.length);
      // The first line's column is the comment's own indent. Continuation
      // lines are kept relative to it, so the printer can move the whole
      // comment to its target indent. Storing the raw slice made a second
      // format pass add the indent again: a block comment inside a record
      // grew two spaces per run.
      const column = start - (source.lastIndexOf('\n', start - 1) + 1);
      out.push({ start, end: i, text: blockText(source.slice(start, i), column), trailing: trailingAt(start) });
      continue;
    }
    i++;
  }
  return out;
}

function collectOffsets(m: ModuleNode): number[] {
  const out: number[] = [m.loc.offset];
  // A comment inside `meta { ... }` belongs to the entry it precedes: without
  // these offsets it slid out of the block (the header check below claimed it).
  for (const loc of m.metaEntryLocs ?? []) out.push(loc.offset);
  for (const u of m.uses) out.push(u.loc.offset);
  for (const t of m.types) {
    out.push(t.loc.offset);
    // A field can carry a comment written inside the record; without its
    // offset the printer has nowhere to put it and the comment disappears.
    if (t.type.kind === 'record') for (const field of t.type.fields) out.push(field.loc.offset);
  }
  for (const e of m.errors) {
    out.push(e.loc.offset);
    for (const field of e.fields) out.push(field.loc.offset);
  }
  for (const e of m.enums) {
    out.push(e.loc.offset);
    for (const loc of e.valueLocs ?? []) out.push(loc.offset);
  }
  for (const s of m.services) collectService(s, out);
  collectBlockCloses(m, out);
  for (const w of m.workflows) collectWorkflow(w, out);
  for (const e of m.environments) collectEnv(e, out);
  for (const u of m.uis) collectUi(u, out);
  out.sort((a, b) => a - b);
  return out;
}

// Ends of the nodes whose printed form closes with a brace (or, for an alias,
// with its last token). A comment written after that closing brace on the same
// line has no node starting on its line; these ends give it an anchor, so
// `} // end service` survives a format instead of being dropped.
function collectEnds(m: ModuleNode, out: number[]): void {
  for (const t of m.types) out.push(t.loc.end);
  for (const e of m.errors) out.push(e.loc.end);
  for (const e of m.enums) out.push(e.loc.end);
  for (const s of m.services) {
    out.push(s.loc.end);
    for (const op of s.contract) out.push(op.loc.end);
    for (const sg of s.sagas) {
      out.push(sg.loc.end);
      for (const st of sg.steps) out.push(st.loc.end);
    }
    for (const ex of s.examples) out.push(ex.loc.end);
  }
  for (const w of m.workflows) {
    out.push(w.loc.end);
    for (const st of w.steps) out.push(st.loc.end);
  }
  for (const e of m.environments) out.push(e.loc.end);
  for (const u of m.uis) {
    out.push(u.loc.end);
    for (const s of u.slides) out.push(s.loc.end);
  }
}

// Offsets of recorded closing braces mapped to the end of the node they close.
// A trailing comment on such a line reaches the brace offset before the node
// end, so both anchors must name the same block.
// Block closings that are not node ends (contract, rules, effects, examples,
// budget) are keyed by their own offset: the printer passes that number back.
function collectBlockCloses(m: ModuleNode, out: number[]): void {
  for (const s of m.services) {
    for (const loc of Object.values(s.blockCloses ?? {})) if (loc) out.push(loc.offset);
  }
}

function collectCloseEnds(m: ModuleNode, out: Map<number, number>): void {
  const add = (loc: Loc | undefined, end: number): void => {
    if (loc) out.set(loc.offset, end);
  };
  for (const s of m.services) for (const sg of s.sagas) for (const st of sg.steps) add(st.closeLoc, st.loc.end);
  for (const w of m.workflows) {
    add(w.closeLoc, w.loc.end);
    for (const st of w.steps) add(st.closeLoc, st.loc.end);
  }
  for (const u of m.uis) {
    add(u.closeLoc, u.loc.end);
    for (const s of u.slides) add(s.closeLoc, s.loc.end);
  }
}

function collectService(s: ServiceNode, out: number[]): void {
  out.push(s.loc.offset);
  for (const loc of Object.values(s.blockOpens ?? {})) if (loc) out.push(loc.offset);
  for (const loc of s.metaEntryLocs ?? []) out.push(loc.offset);
  for (const c of s.uses) out.push(c.loc.offset);
  if (s.effects) {
    out.push(s.effects.loc.offset);
    for (const loc of Object.values(s.effects.clauseLocs ?? {})) out.push(loc.offset);
    for (const loc of [...(s.effects.nameLocs?.allow ?? []), ...(s.effects.nameLocs?.deny ?? [])]) out.push(loc.offset);
  }
  for (const r of s.rules) out.push(r.loc.offset);
  for (const op of s.contract) {
    out.push(op.loc.offset);
    for (const c of op.clauses) out.push(c.loc.offset);
  }
  for (const sg of s.sagas) {
    out.push(sg.loc.offset);
    for (const st of sg.steps) {
      out.push(st.loc.offset);
      for (const loc of Object.values(st.clauseLocs ?? {})) out.push(loc.offset);
      if (st.closeLoc) out.push(st.closeLoc.offset);
    }
  }
  for (const ex of s.examples) {
    out.push(ex.loc.offset);
    for (const stmt of [...ex.given, ...ex.when, ...ex.then]) out.push(stmt.loc.offset);
  }
  if (s.budget) {
    out.push(s.budget.loc.offset);
    for (const item of s.budget.items) out.push(item.loc.offset);
  }
}

function collectWorkflow(w: WorkflowNode, out: number[]): void {
  out.push(w.loc.offset);
  // Clause keywords: without their offsets a comment above `trigger` slid onto
  // the first step, and the one above the last clause left the block entirely.
  for (const loc of Object.values(w.clauseLocs ?? {})) out.push(loc.offset);
  if (w.closeLoc) out.push(w.closeLoc.offset);
  for (const st of w.steps) {
    out.push(st.loc.offset);
    for (const loc of Object.values(st.clauseLocs ?? {})) out.push(loc.offset);
    if (st.closeLoc) out.push(st.closeLoc.offset);
  }
}

function collectEnv(e: EnvironmentNode, out: number[]): void {
  out.push(e.loc.offset);
  for (const b of e.binds) out.push(b.loc.offset);
  if (e.deploy) out.push(e.deploy.loc.offset);
}

function collectUi(u: UiNode, out: number[]): void {
  out.push(u.loc.offset);
  // The same for ui properties: their comments used to be dumped past the
  // closing brace, at the end of the file.
  for (const loc of Object.values(u.clauseLocs ?? {})) out.push(loc.offset);
  if (u.closeLoc) out.push(u.closeLoc.offset);
  for (const s of u.slides) {
    out.push(s.loc.offset);
    if (s.bodyLoc) out.push(s.bodyLoc.offset);
    if (s.closeLoc) out.push(s.closeLoc.offset);
  }
}

// ---------------- printer ----------------

class Printer {
  private out: string[] = [];
  private comments: Map<number, string[]>;
  private trailing: Map<number, string[]>;
  // Comments written inside the module header braces. The header has no child
  // nodes of its own, so a leading comment there would otherwise slide to the
  // first declaration after the block.
  private moduleComments: string[];
  // Comments that follow the last declaration: no node starts after them, so
  // they are printed at the end of the file instead of being dropped.
  private tailComments: string[];
  // Comments after the last `meta` entry, still inside the block.
  private metaTail: string[];
  // Trailing comments wait for the next emitted line: the node that owns them
  // prints exactly one line right after its emitComments call.
  private pending: string[] = [];
  // Comments written after a closing brace on its own line, keyed by the
  // closing node's end. The block prints them back on that brace line.
  private braceTrailing: Map<number, string[]>;
  // Comments written inside a type/error/enum body after its last field. No
  // node starts after them, so they used to slide to the next declaration or
  // out of the file; they are printed before that body's closing brace.
  private bodyTails: Map<number, string[]>;
  // Comments after the last entry of a service meta block, keyed by the
  // service offset. They used to be printed above the next uses line.
  private serviceMetaTails: Map<number, string[]>;

  constructor(comments: Map<number, string[]>, trailing: Map<number, string[]> = new Map(), moduleComments: string[] = [], tailComments: string[] = [], metaTail: string[] = [], braceTrailing: Map<number, string[]> = new Map(), bodyTails: Map<number, string[]> = new Map(), serviceMetaTails: Map<number, string[]> = new Map()) {
    this.comments = comments;
    this.trailing = trailing;
    this.moduleComments = moduleComments;
    this.tailComments = tailComments;
    this.metaTail = metaTail;
    this.braceTrailing = braceTrailing;
    this.bodyTails = bodyTails;
    this.serviceMetaTails = serviceMetaTails;
  }

  // The last line of a block, with the comment that trailed its closing brace.
  private closeLine(indent: number, text: string, end: number): void {
    const cs = this.braceTrailing.get(end);
    if (cs && cs.length > 0) this.raw(indent, text + '  ' + cs.join(' '));
    else this.raw(indent, text);
  }

  private raw(indent: number, text: string): void {
    // An empty line stays empty: indenting it would write trailing spaces into
    // a comment or the end of a block.
    let line = text === '' ? '' : '  '.repeat(indent) + text;
    if (this.pending.length > 0) {
      line += '  ' + this.pending.join(' ');
      this.pending = [];
    }
    this.out.push(line);
  }

  private blank(): void {
    this.out.push('');
  }

  // Declarations of one module group are printed back to back. For single-line
  // declarations (type aliases, `error NotFound`, uses) that is the canonical
  // layout of the specs in examples/. Blocks (`service … {`, `workflow … {`)
  // are not: without a separator the closing brace of one declaration runs
  // straight into the header of the next, which looks like a syntax error and
  // makes the diff of an added workflow unreadable. A block therefore gets a
  // blank line on both sides, and the line is inserted before the item's
  // comments, not after them.
  private declarations<T>(items: T[], print: (item: T) => void): void {
    let prevBlock = false;
    for (const item of items) {
      const start = this.out.length;
      print(item);
      const block = this.out.length - start > 1;
      if ((prevBlock || block) && start > 0 && this.out[start - 1] !== '') {
        this.out.splice(start, 0, '');
      }
      prevBlock = block;
    }
  }

  private emitComments(offset: number, indent: number): void {
    this.pending = [];
    const cs = this.comments.get(offset);
    if (cs) {
      for (const c of cs) {
        if (c.startsWith('//')) {
          this.raw(indent, c);
        } else {
          for (const line of c.split('\n')) this.raw(indent, line);
        }
      }
    }
    const trail = this.trailing.get(offset);
    if (trail && trail.length > 0) this.pending = trail;
  }

  module(m: ModuleNode): string {
    this.emitComments(m.loc.offset, 0);
    this.raw(0, 'module ' + m.name + ' @' + m.version + ' {');
    if (Object.keys(m.meta).length > 0) {
      const entries = Object.entries(m.meta);
      const locs = m.metaEntryLocs ?? [];
      const commented = locs.length === entries.length &&
        entries.some((_, i) => this.comments.has(locs[i].offset) || this.trailing.has(locs[i].offset));
      this.raw(1, 'meta {');
      entries.forEach(([k, v], i) => {
        if (commented) this.emitComments(locs[i].offset, 2);
        this.raw(2, k + ': ' + quoteStr(v));
      });
      for (const c of this.metaTail) {
        if (c.startsWith('//')) this.raw(2, c);
        else for (const line of c.split('\n')) this.raw(2, line);
      }
      this.raw(1, '}');
    }
    for (const c of this.moduleComments) {
      if (c.startsWith('//')) this.raw(1, c);
      else for (const line of c.split('\n')) this.raw(1, line);
    }
    this.raw(0, '}');

    const groups: Array<[string, () => void]> = [];
    if (m.uses.length) groups.push(['uses', () => { this.declarations(m.uses, (u) => this.use(u)); }]);
    if (m.types.length) groups.push(['types', () => { this.declarations(m.types, (t) => this.typeDecl(t)); }]);
    if (m.errors.length) groups.push(['errors', () => { this.declarations(m.errors, (e) => this.errorDecl(e)); }]);
    if (m.enums.length) groups.push(['enums', () => { this.declarations(m.enums, (e) => this.enumDecl(e)); }]);
    if (m.services.length) groups.push(['services', () => { this.declarations(m.services, (s) => this.service(s)); }]);
    if (m.workflows.length) groups.push(['workflows', () => { this.declarations(m.workflows, (w) => this.workflow(w)); }]);
    if (m.environments.length) groups.push(['environments', () => { this.declarations(m.environments, (e) => this.environment(e)); }]);
    if (m.uis.length) groups.push(['uis', () => { this.declarations(m.uis, (u) => this.ui(u)); }]);

    for (let g = 0; g < groups.length; g++) {
      this.blank();
      groups[g][1]();
    }

    if (this.tailComments.length > 0) {
      this.blank();
      for (const c of this.tailComments) {
        if (c.startsWith('//')) this.raw(0, c);
        else for (const line of c.split('\n')) this.raw(0, line);
      }
    }

    return this.out.join('\n') + '\n';
  }

  private use(u: UseNode): void {
    this.emitComments(u.loc.offset, 0);
    let s = 'use ' + u.what + ' ' + u.name;
    if (u.version) s += ' @' + u.version;
    this.raw(0, s);
  }

  private typeDecl(t: TypeDecl): void {
    this.emitComments(t.loc.offset, 0);
    const fields = t.type.kind === 'record' ? t.type.fields : [];
    // A comment after the last field still lives inside the braces: it makes
    // the record multi-line on its own.
    const tail = this.bodyTails.has(t.loc.end);
    if (tail || fields.some((field) => this.comments.has(field.loc.offset) || this.trailing.has(field.loc.offset))) {
      // One commented field turns the record multi-line, so the comment keeps
      // the field it describes instead of floating above the declaration.
      this.raw(0, 'type ' + t.name + ' = {');
      for (let i = 0; i < fields.length; i++) {
        this.emitComments(fields[i].loc.offset, 1);
        this.raw(1, param(fields[i]) + (i < fields.length - 1 ? ',' : ''));
      }
      this.bodyTail(t.loc.end, 1);
      this.closeLine(0, '}', t.loc.end);
      return;
    }
    this.closeLine(0, 'type ' + t.name + ' = ' + type(t.type), t.loc.end);
  }

  private errorDecl(e: ErrorDecl): void {
    this.emitComments(e.loc.offset, 0);
    const tail = this.bodyTails.has(e.loc.end);
    if (e.fields.length === 0 && !tail) {
      this.closeLine(0, 'error ' + e.name, e.loc.end);
      return;
    }
    const commented = tail || e.fields.some((field) => this.comments.has(field.loc.offset) || this.trailing.has(field.loc.offset));
    if (!commented) {
      this.raw(0, 'error ' + e.name + ' {');
      for (const f of e.fields) this.raw(1, param(f));
      this.closeLine(0, '}', e.loc.end);
      return;
    }
    // Same rule as a record: a commented field needs a line of its own.
    this.raw(0, 'error ' + e.name + ' {');
    for (const f of e.fields) {
      this.emitComments(f.loc.offset, 1);
      this.raw(1, param(f));
    }
    this.bodyTail(e.loc.end, 1);
    this.closeLine(0, '}', e.loc.end);
  }

  private enumDecl(e: { kind: string; name: string; values: string[]; valueLocs?: Loc[]; loc: Loc }): void {
    this.emitComments(e.loc.offset, 0);
    const locs = e.valueLocs ?? [];
    const tail = this.bodyTails.has(e.loc.end);
    const commented = tail || (locs.length === e.values.length &&
      e.values.some((_, index) => this.comments.has(locs[index].offset) || this.trailing.has(locs[index].offset)));
    if (!commented) {
      this.closeLine(0, e.values.length === 0 ? 'enum ' + e.name + ' {}' : 'enum ' + e.name + ' { ' + e.values.join(', ') + ' }', e.loc.end);
      return;
    }
    // A commented value needs its own line, exactly like a commented field.
    this.raw(0, 'enum ' + e.name + ' {');
    for (let index = 0; index < e.values.length; index += 1) {
      this.emitComments(locs[index].offset, 1);
      this.raw(1, e.values[index] + (index < e.values.length - 1 ? ',' : ''));
    }
    this.bodyTail(e.loc.end, 1);
    this.closeLine(0, '}', e.loc.end);
  }

  private service(s: ServiceNode): void {
    this.emitComments(s.loc.offset, 0);
    const head = (s.external ? 'external service ' : 'service ') + s.name + ' : ' + s.impl + ' {';
    this.raw(0, head);
    // An empty `meta {` is dropped, unless it carries a comment: the note has
    // no entry to sit above and would otherwise be lost with the block.
    const metaTailComments = this.serviceMetaTails.get(s.loc.offset);
    if (Object.keys(s.meta).length > 0 || (metaTailComments !== undefined && metaTailComments.length > 0)) {
      const entries = Object.entries(s.meta);
      const locs = s.metaEntryLocs ?? [];
      const commented = locs.length === entries.length &&
        entries.some((_, i) => this.comments.has(locs[i].offset) || this.trailing.has(locs[i].offset));
      this.raw(1, 'meta {');
      entries.forEach(([k, v], i) => {
        if (commented) this.emitComments(locs[i].offset, 2);
        this.raw(2, k + ': ' + quoteStr(v));
      });
      const metaTail = this.serviceMetaTails.get(s.loc.offset);
      if (metaTail) {
        for (const c of metaTail) {
          if (c.startsWith('//')) this.raw(2, c);
          else for (const line of c.split('\n')) this.raw(2, line);
        }
      }
      this.raw(1, '}');
      this.blank();
    }
    const body: Array<() => void> = [];
    if (s.uses.length > 0) body.push(() => { for (const c of s.uses) this.capUse(c); });
    if (s.roles.length > 0) body.push(() => this.raw(1, 'roles: ' + s.roles.join(', ')));
    if (s.effects) body.push(() => this.effects(s.effects!, s.blockCloses?.effects));
    if (s.rules.length > 0 || this.hasBlockComments(s.blockCloses?.rules, s.blockOpens?.rules)) body.push(() => this.rules(s.rules, s.blockCloses?.rules, s.blockOpens?.rules));
    if (s.contract.length > 0 || this.hasBlockComments(s.blockCloses?.contract, s.blockOpens?.contract)) body.push(() => this.contract(s.contract, s.blockCloses?.contract, s.blockOpens?.contract));
    for (const sg of s.sagas) body.push(() => this.saga(sg));
    if (s.examples.length > 0 || this.hasBlockComments(s.blockCloses?.examples, s.blockOpens?.examples)) body.push(() => this.examples(s.examples, s.blockCloses?.examples, s.blockOpens?.examples));
    if (s.budget) body.push(() => this.budget(s.budget!, s.blockCloses?.budget));
    for (let i = 0; i < body.length; i++) {
      if (i > 0) this.blank();
      body[i]();
    }
    this.bodyTail(s.loc.end, 1);
    this.closeLine(0, '}', s.loc.end);
  }

  private capUse(c: CapUse): void {
    this.emitComments(c.loc.offset, 1);
    let s = 'uses ' + c.alias + ': ' + c.capability;
    const keys = Object.keys(c.params);
    if (keys.length > 0) s += '(' + keys.map((k) => k + ': ' + expr(c.params[k])).join(', ') + ')';
    this.raw(1, s);
  }

  private effects(e: EffectsNode, close?: Loc): void {
    this.emitComments(e.loc.offset, 1);
    this.raw(1, 'effects {');
    const clause = (key: 'allow' | 'deny', list: string[]): void => {
      if (list.length === 0) return;
      this.clauseComments(e.clauseLocs, key, 2);
      const locs = e.nameLocs?.[key] ?? [];
      const commented = locs.some((loc) => this.comments.has(loc.offset) || this.trailing.has(loc.offset));
      // One name per line only when a comment needs the line; otherwise the
      // list stays on the keyword line.
      if (!commented || locs.length !== list.length) {
        this.raw(2, key + ' ' + list.join(', '));
        return;
      }
      this.raw(2, key);
      list.forEach((name, i) => {
        this.emitComments(locs[i].offset, 3);
        this.raw(3, name);
      });
    };
    clause('allow', e.allow);
    clause('deny', e.deny);
    if (close) this.bodyTail(close.offset, 2);
    this.closeLine(1, '}', close?.offset ?? -1);
  }

  private rules(rs: RuleNode[], close?: Loc, head?: Loc): void {
    if (head) this.emitComments(head.offset, 1);
    this.raw(1, 'rules {');
    for (const r of rs) {
      this.emitComments(r.loc.offset, 2);
      switch (r.kind) {
        case 'invariant': this.raw(2, 'invariant ' + r.name + ': ' + expr(r.expr)); break;
        case 'atomic': this.raw(2, 'atomic ' + r.name + ' { ' + r.steps.join('; ') + ' }'); break;
        case 'ordering': this.raw(2, 'ordering { ' + r.pairs.map(([a, b]) => a + ' before ' + b).join('; ') + ' }'); break;
        case 'unique': this.raw(2, 'unique ' + r.path); break;
        case 'index': this.raw(2, 'index ' + r.path); break;
      }
    }
    if (close) this.bodyTail(close.offset, 2);
    this.closeLine(1, '}', close?.offset ?? -1);
  }

  private contract(ops: OpNode[], close?: Loc, head?: Loc): void {
    // A comment above the keyword belongs to the block, not to its first op.
    if (head) this.emitComments(head.offset, 1);
    this.raw(1, 'contract {');
    // No blank line right after `contract {`: the first operation starts the
    // block, as it does in every other clause.
    for (let i = 0; i < ops.length; i++) {
      if (i > 0) this.blank();
      this.op(ops[i], 2);
    }
    if (close) this.bodyTail(close.offset, 2);
    this.closeLine(1, '}', close?.offset ?? -1);
  }

  private op(op: OpNode, indent: number): void {
    this.emitComments(op.loc.offset, indent);
    let head = '';
    if (op.kind === 'job') head = 'job ' + op.name;
    else head = (op.isPublic ? 'public op ' : op.auth ? 'auth op ' : 'op ') + op.name;
    head += params(op.params);
    if (op.returns) head += ' -> ' + type(op.returns);
    this.raw(indent, head + ' {');
    for (const c of op.clauses) {
      this.emitComments(c.loc.offset, indent + 1);
      this.clause(c, indent + 1);
    }
    this.bodyTail(op.loc.end, indent + 1);
    this.closeLine(indent, '}', op.loc.end);
  }

  private clause(c: Clause, indent: number): void {
    switch (c.kind) {
      case 'route': this.raw(indent, 'route: ' + quoteStr(c.value)); break;
      case 'effects': this.raw(indent, 'effects: ' + c.names.join(', ')); break;
      case 'errors': this.raw(indent, 'errors: ' + (c.names.length ? c.names.join(', ') : 'none')); break;
      case 'roles': this.raw(indent, 'roles: ' + c.names.join(', ')); break;
      case 'owner': this.raw(indent, 'owner: ' + c.param); break;
      case 'pre': this.raw(indent, 'pre: ' + expr(c.expr)); break;
      case 'post': this.raw(indent, 'post: ' + expr(c.expr)); break;
      case 'onerror': this.raw(indent, 'on error ' + c.error + ': ' + expr(c.expr)); break;
      case 'consume': this.raw(indent, 'on: ' + c.source); break;
      case 'saga': this.raw(indent, 'saga: ' + c.name); break;
      case 'retry': this.raw(indent, 'retry: ' + c.value); break;
      case 'schedule': this.raw(indent, 'schedule: ' + quoteStr(c.value)); break;
      case 'idempotent': this.raw(indent, 'idempotent'); break;
      case 'since': this.raw(indent, 'since: ' + quoteStr(c.value)); break;
    }
  }

  private saga(sg: SagaNode): void {
    this.emitComments(sg.loc.offset, 1);
    this.raw(1, 'saga ' + sg.name + ' {');
    for (const st of sg.steps) {
      this.emitComments(st.loc.offset, 2);
      // A saga step is one line until a comment needs a line of its own.
      const clauseKeys = Object.keys(st.clauseLocs ?? {});
      const commented = clauseKeys.some((k) => this.comments.has(st.clauseLocs![k].offset) || this.trailing.has(st.clauseLocs![k].offset)) ||
        (st.closeLoc !== undefined && this.comments.has(st.closeLoc.offset));
      if (!commented) {
        const parts: string[] = [];
        if (st.call) parts.push('call: ' + st.call);
        if (st.compensate) parts.push('compensate: ' + st.compensate);
        if (st.retry !== null) parts.push('retry: ' + st.retry);
        this.closeLine(2, 'step ' + st.name + ' { ' + parts.join(' ') + ' }', st.loc.end);
        continue;
      }
      this.raw(2, 'step ' + st.name + ' {');
      const sc = (key: string): void => { this.clauseComments(st.clauseLocs, key, 3); };
      if (st.call) { sc('call'); this.raw(3, 'call: ' + st.call); }
      if (st.compensate) { sc('compensate'); this.raw(3, 'compensate: ' + st.compensate); }
      if (st.retry !== null) { sc('retry'); this.raw(3, 'retry: ' + st.retry); }
      this.blockTail(st.closeLoc, 3);
      this.closeLine(2, '}', st.loc.end);
    }
    this.closeLine(1, '}', sg.loc.end);
  }

  private examples(exs: ExampleNode[], close?: Loc, head?: Loc): void {
    if (head) this.emitComments(head.offset, 1);
    this.raw(1, 'examples {');
    for (const ex of exs) {
      this.blank();
      this.emitComments(ex.loc.offset, 2);
      this.raw(2, 'example ' + ex.name + ' {');
      if (ex.given.length) this.section('given', ex.given, 3, ex.sectionCloses?.given);
      if (ex.when.length) this.section('when', ex.when, 3, ex.sectionCloses?.when);
      if (ex.then.length) this.section('then', ex.then, 3, ex.sectionCloses?.then);
      this.bodyTail(ex.loc.end, 3);
      this.closeLine(2, '}', ex.loc.end);
    }
    if (close) this.bodyTail(close.offset, 2);
    this.closeLine(1, '}', close?.offset ?? -1);
  }

  private section(name: string, stmts: Stmt[], indent: number, close?: Loc): void {
    this.raw(indent, name + ' {');
    for (const st of stmts) {
      this.emitComments(st.loc.offset, indent + 1);
      if (st.kind === 'let') this.raw(indent + 1, 'let ' + st.name + ' = ' + expr(st.expr));
      else this.raw(indent + 1, expr(st.expr));
    }
    if (close) this.bodyTail(close.offset, indent + 1);
    this.raw(indent, '}');
  }

  private budget(b: BudgetNode, close?: Loc): void {
    this.emitComments(b.loc.offset, 1);
    this.raw(1, 'budget {');
    for (const item of b.items) {
      this.emitComments(item.loc.offset, 2);
      let s = item.key + ': ';
      if (item.op) s += item.op + ' ';
      s += expr(item.expr);
      this.raw(2, s);
    }
    if (close) this.bodyTail(close.offset, 2);
    this.closeLine(1, '}', close?.offset ?? -1);
  }

  // Comments attached to a clause keyword are printed right before that
  // clause's line; the printer prints exactly one line after each call, so the
  // comment cannot drift to a neighbour. Returns whether the key was written.
  private clauseComments(locs: Record<string, Loc> | undefined, key: string, indent: number): boolean {
    const loc = locs?.[key];
    if (!loc) return false;
    this.emitComments(loc.offset, indent);
    return true;
  }

  // Comments written after the last clause of a block still belong inside it.
  // A trailing comment on the closing brace itself is dropped, as everywhere
  // else: it has no line of its own anymore.
  // Comments written after the last field of a type/error/enum body, still
  // inside its braces, are printed at the body's indent before the brace.
  // Whether a block carries a comment with nowhere else to go: after its last
  // clause, or trailing its opening or closing brace. An empty block has no
  // child to hold such a note, so the printer has to keep the block itself:
  // dropping `contract {` would drop the comment with it.
  private hasBlockComments(close: Loc | undefined, head: Loc | undefined): boolean {
    if (head && this.trailing.has(head.offset)) return true;
    if (!close) return false;
    const tail = this.bodyTails.get(close.offset);
    if (tail !== undefined && tail.length > 0) return true;
    return this.braceTrailing.has(close.offset);
  }

  private bodyTail(end: number, indent: number): void {
    const cs = this.bodyTails.get(end);
    if (!cs || cs.length === 0) return;
    this.pending = [];
    for (const c of cs) {
      if (c.startsWith('//')) this.raw(indent, c);
      else for (const line of c.split('\n')) this.raw(indent, line);
    }
    this.pending = [];
  }

  private blockTail(loc: Loc | undefined, indent: number): void {
    if (!loc) return;
    const cs = this.comments.get(loc.offset);
    if (!cs || cs.length === 0) return;
    this.pending = [];
    for (const c of cs) {
      if (c.startsWith('//')) this.raw(indent, c);
      else for (const line of c.split('\n')) this.raw(indent, line);
    }
    this.pending = [];
  }

  private workflow(w: WorkflowNode): void {
    this.emitComments(w.loc.offset, 0);
    this.raw(0, 'workflow ' + w.name + ' {');
    const clause = (key: string): void => { this.clauseComments(w.clauseLocs, key, 1); };
    if (w.trigger) { clause('trigger'); this.raw(1, 'trigger ' + this.trigger(w.trigger)); }
    if (w.overlap) { clause('overlap'); this.raw(1, 'overlap: ' + w.overlap); }
    if (w.catchup) { clause('catchup'); this.raw(1, 'catchup: ' + w.catchup); }
    if (w.retry !== null) { clause('retry'); this.raw(1, 'retry: ' + w.retry); }
    if (w.timeout) { clause('timeout'); this.raw(1, 'timeout: ' + expr(w.timeout)); }
    for (const st of w.steps) {
      this.blank();
      this.emitComments(st.loc.offset, 1);
      let head = 'step ' + st.name + params(st.params);
      if (st.returns) head += ' -> ' + type(st.returns);
      this.raw(1, head + ' {');
      const sc = (key: string): void => { this.clauseComments(st.clauseLocs, key, 2); };
      if (st.call) { sc('call'); this.raw(2, 'call: ' + st.call); }
      if (st.needs.length) { sc('needs'); this.raw(2, 'needs: ' + st.needs.join(', ')); }
      if (st.effects.length) { sc('effects'); this.raw(2, 'effects: ' + st.effects.join(', ')); }
      if (st.onFail) { sc('onFail'); this.raw(2, 'onFail: ' + st.onFail); }
      if (st.retry !== null) { sc('retry'); this.raw(2, 'retry: ' + st.retry); }
      if (st.timeout) { sc('timeout'); this.raw(2, 'timeout: ' + expr(st.timeout)); }
      this.blockTail(st.closeLoc, 2);
      this.closeLine(1, '}', st.loc.end);
    }
    this.blockTail(w.closeLoc, 1);
    this.closeLine(0, '}', w.loc.end);
  }

  private trigger(t: TriggerNode): string {
    if (t.args.length === 0) return t.kind;
    // `after` keeps its argument outside the parentheses; the canonical form
    // is the one a reader writes: after 30s, after Cleanup.
    if (t.kind === 'after' && t.args.length === 1 && !t.args[0].name) return 'after ' + expr(t.args[0].value);
    return t.kind + '(' + t.args.map((a) => (a.name ? a.name + ': ' : '') + expr(a.value)).join(', ') + ')';
  }

  private environment(e: EnvironmentNode): void {
    this.emitComments(e.loc.offset, 0);
    this.raw(0, 'environment ' + e.name + ' {');
    for (const b of e.binds) {
      this.emitComments(b.loc.offset, 1);
      let s = 'bind ' + b.alias + ' -> ' + b.provider;
      const keys = Object.keys(b.args);
      if (keys.length > 0) s += '(' + keys.map((k) => k + ': ' + expr(b.args[k])).join(', ') + ')';
      if (b.guarantees.length > 0) s += ' guarantees [' + b.guarantees.join(', ') + ']';
      this.raw(1, s);
    }
    if (e.deploy) {
      this.emitComments(e.deploy.loc.offset, 1);
      const d = e.deploy;
      let s = 'deploy ' + d.provider;
      const keys = Object.keys(d.args);
      if (keys.length > 0) s += '(' + keys.map((k) => k + ': ' + expr(d.args[k])).join(', ') + ')';
      this.raw(1, s);
    }
    this.bodyTail(e.loc.end, 1);
    this.closeLine(0, '}', e.loc.end);
  }

  private ui(u: UiNode): void {
    this.emitComments(u.loc.offset, 0);
    this.raw(0, 'ui ' + u.name + ' {');
    // `kind` and `impl` fill the same field; the source may use either word.
    const clause = (key: string): void => {
      if (!this.clauseComments(u.clauseLocs, key, 1) && key === 'kind') this.clauseComments(u.clauseLocs, 'impl', 1);
    };
    clause('kind'); this.raw(1, 'kind: ' + u.impl);
    clause('route'); this.raw(1, 'route: ' + quoteStr(u.route));
    if (u.title !== null) { clause('title'); this.raw(1, 'title: ' + quoteStr(u.title)); }
    if (u.layout) { clause('layout'); this.raw(1, 'layout: ' + u.layout); }
    if (u.locale !== null) { clause('locale'); this.raw(1, 'locale: ' + quoteStr(u.locale)); }
    if (u.locales) { clause('locales'); this.raw(1, 'locales: ' + quoteStr(u.locales.join(', '))); }
    // A default-valued property is not printed, but its comment still belongs
    // inside the block: print it where the line would have gone.
    if (u.theme && u.theme !== 'auto') { clause('theme'); this.raw(1, 'theme: ' + u.theme); }
    else clause('theme');
    if (u.render && u.render !== 'static') { clause('render'); this.raw(1, 'render: ' + u.render); }
    else clause('render');
    if (u.start) { clause('start'); this.raw(1, 'start: ' + u.start); }
    if (u.join) { clause('join'); this.raw(1, 'join: ' + u.join); }
    if (u.state) { clause('state'); this.raw(1, 'state: ' + u.state); }
    if (u.advance) { clause('advance'); this.raw(1, 'advance: ' + u.advance); }
    if (u.history) { clause('history'); this.raw(1, 'history: ' + u.history); }
    if (u.send) { clause('send'); this.raw(1, 'send: ' + u.send); }
    if (u.uses.length) { clause('uses'); this.raw(1, 'uses ' + u.uses.join(', ')); }
    for (const s of u.slides) {
      this.emitComments(s.loc.offset, 1);
      this.raw(1, 'slide ' + quoteStr(s.title) + ' {');
      if (s.body !== null) {
        if (s.bodyLoc) this.emitComments(s.bodyLoc.offset, 2);
        this.raw(2, 'body: ' + quoteStr(s.body));
      }
      this.blockTail(s.closeLoc, 2);
      this.closeLine(1, '}', s.loc.end);
    }
    this.blockTail(u.closeLoc, 1);
    this.closeLine(0, '}', u.loc.end);
  }
}

// ---------------- public API ----------------

export function printModule(mod: ModuleNode): string {
  return new Printer(new Map()).module(mod);
}

export function formatSource(source: string, file: string): string {
  // A BOM is a file-encoding artifact, so the canonical form never carries it.
  // Dropping it here keeps extractComments and the AST offsets in one
  // coordinate system (the lexer skips it too).
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const mod = parse(source, file);
  const comments = extractComments(source);
  const offsets = collectOffsets(mod);
  const ends: number[] = [];
  collectEnds(mod, ends);
  ends.sort((a, b) => b - a);
  const blockCloses: number[] = [];
  collectBlockCloses(mod, blockCloses);
  // A closing brace is on its line through its first character; a node ends
  // just past it. Both are anchors, keyed by what the printer looks up.
  const anchors: Array<{ key: number; pos: number }> = [
    ...ends.map((end) => ({ key: end, pos: end - 1 })),
    ...blockCloses.map((offset) => ({ key: offset, pos: offset })),
  ].sort((a, b) => b.key - a.key);
  const closeEnds = new Map<number, number>();
  collectCloseEnds(mod, closeEnds);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const leading = new Map<number, string[]>();
  const trailing = new Map<number, string[]>();
  const moduleComments: string[] = [];
  const tailComments: string[] = [];
  const metaTail: string[] = [];
  // Comments after a closing brace, anchored on the node that brace closes.
  const braceTrailing = new Map<number, string[]>();
  // Bodies (a record type, an error, an enum) and the offset of their last
  // field. A comment written after that field but before the brace has no node
  // of its own, so the leading rule would anchor it past the declaration.
  const bodyTails = new Map<number, string[]>();
  const serviceMetaTails = new Map<number, string[]>();
  const bodies: Array<{ key: number; lastEnd: number; close: number }> = [];
  const addBody = (key: number, lastEnd: number, close: number): void => {
    if (close > lastEnd) bodies.push({ key, lastEnd, close });
  };
  for (const t of mod.types) {
    if (t.type.kind !== 'record') continue;
    const last = t.type.fields[t.type.fields.length - 1];
    addBody(t.loc.end, last ? last.loc.end : t.type.loc.offset, t.loc.end);
  }
  for (const e of mod.errors) {
    if (e.fields.length === 0) continue;
    addBody(e.loc.end, e.fields[e.fields.length - 1].loc.end, e.loc.end);
  }
  for (const e of mod.enums) {
    const locs = e.valueLocs ?? [];
    if (locs.length === 0) continue;
    addBody(e.loc.end, locs[locs.length - 1].end, e.loc.end);
  }
  // A service owns several bodies: its own braces, each operation's body, and
  // the contract/rules/effects/examples/budget blocks. A comment after the
  // last child used to be keyed on the closing brace and dropped, because the
  // brace printer only looked for trailing comments.
  for (const e of mod.environments) {
    const ends = e.binds.map((b) => b.loc.end);
    if (e.deploy) ends.push(e.deploy.loc.end);
    addBody(e.loc.end, ends.length > 0 ? Math.max(...ends) : e.loc.offset, e.loc.end);
  }
  for (const s of mod.services) {
    const ends = [
      ...s.uses.map((u) => u.loc.end),
      ...s.rules.map((r) => r.loc.end),
      ...s.contract.map((op) => op.loc.end),
      ...s.sagas.map((sg) => sg.loc.end),
      ...s.examples.map((ex) => ex.loc.end),
    ];
    if (s.effects) ends.push(s.effects.loc.end);
    if (s.budget) ends.push(s.budget.loc.end);
    addBody(s.loc.end, ends.length > 0 ? Math.max(...ends) : s.loc.offset, s.loc.end);
    for (const op of s.contract) {
      const clauses = op.clauses.map((c) => c.loc.end);
      addBody(op.loc.end, clauses.length > 0 ? Math.max(...clauses) : op.loc.offset, op.loc.end);
    }
    for (const ex of s.examples) {
      const stmts = [...ex.given, ...ex.when, ...ex.then];
      const ends = stmts.map((st) => st.loc.end);
      addBody(ex.loc.end, ends.length > 0 ? Math.max(...ends) : ex.loc.offset, ex.loc.end);
      for (const key of ['given', 'when', 'then'] as const) {
        const close = ex.sectionCloses?.[key];
        if (!close) continue;
        const list = ex[key];
        const inner = list.map((st) => st.loc.end);
        addBody(close.offset, inner.length > 0 ? Math.max(...inner) : close.offset - 1, close.offset);
      }
    }
    const closes = s.blockCloses ?? {};
    const lastOp = s.contract[s.contract.length - 1];
    const lastRule = s.rules[s.rules.length - 1];
    const lastExample = s.examples[s.examples.length - 1];
    // An empty block still owns a comment written between its braces: with no
    // child to hold it the note used to fall past the closing brace and vanish
    // (a block with no declarations is not printed at all). Registering the
    // block with its keyword as the last child keeps that comment inside.
    const blockBody = (key: 'contract' | 'rules' | 'examples', close: Loc | undefined, lastEnd: number | undefined): void => {
      if (!close) return;
      const open = s.blockOpens?.[key];
      addBody(close.offset, lastEnd ?? (open ? open.offset - 1 : close.offset - 1), close.offset);
    };
    blockBody('contract', closes.contract, lastOp?.loc.end);
    blockBody('rules', closes.rules, lastRule?.loc.end);
    if (closes.effects && s.effects) addBody(closes.effects.offset, s.effects.loc.offset, closes.effects.offset);
    blockBody('examples', closes.examples, lastExample?.loc.end);
    if (closes.budget && s.budget) addBody(closes.budget.offset, s.budget.loc.offset, closes.budget.offset);
  }
  for (const c of comments) {
    // A comment written between the module header braces belongs to the block,
    // not to the first declaration after it. Trailing ones keep the normal path
    // and stay on the header line.
    const inMeta = mod.metaLoc !== undefined && c.start > mod.metaLoc.offset && c.end <= mod.metaLoc.end;
    if (!c.trailing && inMeta) {
      // Inside the meta block: the normal leading rule attaches it to the
      // entry that follows, and Printer.module prints it back at indent 2.
      const entry = (mod.metaEntryLocs ?? []).find((loc) => loc.offset >= c.end);
      if (!entry) {
        // After the last entry: keep it in the block, at the end.
        metaTail.push(c.text);
        continue;
      }
    } else if (!c.trailing && c.start > mod.loc.offset && c.end <= mod.loc.end) {
      moduleComments.push(c.text);
      continue;
    }
    if (c.trailing) {
      // A comment written after a block's closing brace belongs to that block,
      // even when a child node started on the same line (a one-line record).
      // The brace printer puts it back on the line it came from.
      const line = lineOf(c.start);
      const anchor = anchors.find((item) => item.key <= c.start && lineOf(item.pos) === line);
      const braceEnd = anchor?.key;
      if (braceEnd !== undefined) {
        const br = braceTrailing.get(braceEnd) ?? [];
        br.push(c.text.replace(/\s+/g, ' ').trim());
        braceTrailing.set(braceEnd, br);
        continue;
      }
      // Otherwise the deepest node that starts on the comment's own line owns it.
      let target = -1;
      for (let i = offsets.length - 1; i >= 0; i--) {
        const o = offsets[i];
        if (o > c.start) continue;
        const oLine = lineOf(o);
        if (oLine === line) { target = o; break; }
        if (oLine < line) break;
      }
      if (target < 0) {
        // Nothing starts on this line: the comment trails a closing brace.
        // Anchor it on the innermost node that ends on the line, so the brace
        // printer can put it back on that same line.
        const late = anchors.find((item) => item.key <= c.start && lineOf(item.pos) === line);
        if (late === undefined) continue;
        const br = braceTrailing.get(late.key) ?? [];
        br.push(c.text.replace(/\s+/g, ' ').trim());
        braceTrailing.set(late.key, br);
        continue;
      }
      // A recorded closing brace anchors the comment on the block it closes,
      // not on an inner line of the printer.
      const blockEnd = closeEnds.get(target);
      if (blockEnd !== undefined) {
        const br = braceTrailing.get(blockEnd) ?? [];
        br.push(c.text.replace(/\s+/g, ' ').trim());
        braceTrailing.set(blockEnd, br);
        continue;
      }
      const arr = trailing.get(target) ?? [];
      arr.push(c.text.replace(/\s+/g, ' ').trim());
      trailing.set(target, arr);
      continue;
    }
    // A comment after the last entry of a service meta block belongs inside
    // that block, not above the next declaration (the module meta block keeps
    // its own tail; a service had no such rule).
    let metaTailHit = false;
    for (const s of mod.services) {
      const loc = s.metaLoc;
      if (!loc || !(c.start > loc.offset && c.end < loc.end)) continue;
      const entries = s.metaEntryLocs ?? [];
      const lastEnd = entries.length > 0 ? entries[entries.length - 1].end : loc.offset;
      if (c.start <= lastEnd) continue;
      const arr = serviceMetaTails.get(s.loc.offset) ?? [];
      arr.push(c.text);
      serviceMetaTails.set(s.loc.offset, arr);
      metaTailHit = true;
    }
    if (metaTailHit) continue;
    // A leading comment belongs to the first node that starts after it ends.
    let target = -1;
    for (const o of offsets) {
      if (o >= c.end) { target = o; break; }
    }
    // A comment inside a record/error/enum body, after its last field, has no
    // node of its own: the next anchor is the next declaration or the end of
    // the file, which would pull the note out of the braces (and, with a
    // following declaration, make it read as a comment about that one).
    let body: { key: number; lastEnd: number; close: number } | undefined;
    for (const item of bodies) {
      if (!(c.start > item.lastEnd && c.end < item.close)) continue;
      if (!(target < 0 || target >= item.close)) continue;
      // Nested bodies (an operation inside a contract) both match; the
      // innermost one owns the comment.
      if (!body || item.close < body.close) body = item;
    }
    if (body) {
      const arr = bodyTails.get(body.key) ?? [];
      arr.push(c.text);
      bodyTails.set(body.key, arr);
      continue;
    }
    if (target < 0) {
      // Nothing starts after this comment: it closes the file.
      tailComments.push(c.text);
      continue;
    }
    const arr = leading.get(target) ?? [];
    arr.push(c.text);
    leading.set(target, arr);
  }
  return new Printer(leading, trailing, moduleComments, tailComments, metaTail, braceTrailing, bodyTails, serviceMetaTails).module(mod);
}
