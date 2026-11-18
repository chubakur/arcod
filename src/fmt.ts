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
      if (typeof e.value === 'string') return quoteStr(e.value);
      if (e.value === null) return 'null';
      if (typeof e.value === 'boolean') return e.value ? 'true' : 'false';
      return e.raw || String(e.value);
    }
    case 'duration': return e.value + e.unit;
    case 'list': return '[' + e.items.map((item) => expr(item)).join(', ') + ']';
    case 'record': return '{ ' + e.fields.map((field) => field.name + ': ' + expr(field.value)).join(', ') + ' }';
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
    case 'record': return '{ ' + t.fields.map(param).join(', ') + ' }';
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
      out.push({ start, end: i, text: source.slice(start, i), trailing: trailingAt(start) });
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
  for (const w of m.workflows) collectWorkflow(w, out);
  for (const e of m.environments) collectEnv(e, out);
  for (const u of m.uis) collectUi(u, out);
  out.sort((a, b) => a - b);
  return out;
}

function collectService(s: ServiceNode, out: number[]): void {
  out.push(s.loc.offset);
  for (const c of s.uses) out.push(c.loc.offset);
  if (s.effects) out.push(s.effects.loc.offset);
  for (const r of s.rules) out.push(r.loc.offset);
  for (const op of s.contract) {
    out.push(op.loc.offset);
    for (const c of op.clauses) out.push(c.loc.offset);
  }
  for (const sg of s.sagas) {
    out.push(sg.loc.offset);
    for (const st of sg.steps) out.push(st.loc.offset);
  }
  for (const ex of s.examples) {
    out.push(ex.loc.offset);
    for (const stmt of [...ex.given, ...ex.when, ...ex.then]) out.push(stmt.loc.offset);
  }
  if (s.budget) out.push(s.budget.loc.offset);
}

function collectWorkflow(w: WorkflowNode, out: number[]): void {
  out.push(w.loc.offset);
  for (const st of w.steps) out.push(st.loc.offset);
}

function collectEnv(e: EnvironmentNode, out: number[]): void {
  out.push(e.loc.offset);
  for (const b of e.binds) out.push(b.loc.offset);
  if (e.deploy) out.push(e.deploy.loc.offset);
}

function collectUi(u: UiNode, out: number[]): void {
  out.push(u.loc.offset);
  for (const s of u.slides) out.push(s.loc.offset);
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

  constructor(comments: Map<number, string[]>, trailing: Map<number, string[]> = new Map(), moduleComments: string[] = [], tailComments: string[] = [], metaTail: string[] = []) {
    this.comments = comments;
    this.trailing = trailing;
    this.moduleComments = moduleComments;
    this.tailComments = tailComments;
    this.metaTail = metaTail;
  }

  private raw(indent: number, text: string): void {
    let line = '  '.repeat(indent) + text;
    if (this.pending.length > 0) {
      line += '  ' + this.pending.join(' ');
      this.pending = [];
    }
    this.out.push(line);
  }

  private blank(): void {
    this.out.push('');
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
    if (m.uses.length) groups.push(['uses', () => { for (const u of m.uses) this.use(u); }]);
    if (m.types.length) groups.push(['types', () => { for (const t of m.types) this.typeDecl(t); }]);
    if (m.errors.length) groups.push(['errors', () => { for (const e of m.errors) this.errorDecl(e); }]);
    if (m.enums.length) groups.push(['enums', () => { for (const e of m.enums) this.enumDecl(e); }]);
    if (m.services.length) groups.push(['services', () => { for (const s of m.services) this.service(s); }]);
    if (m.workflows.length) groups.push(['workflows', () => { for (const w of m.workflows) this.workflow(w); }]);
    if (m.environments.length) groups.push(['environments', () => { for (const e of m.environments) this.environment(e); }]);
    if (m.uis.length) groups.push(['uis', () => { for (const u of m.uis) this.ui(u); }]);

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
    if (fields.some((field) => this.comments.has(field.loc.offset) || this.trailing.has(field.loc.offset))) {
      // One commented field turns the record multi-line, so the comment keeps
      // the field it describes instead of floating above the declaration.
      this.raw(0, 'type ' + t.name + ' = {');
      for (let i = 0; i < fields.length; i++) {
        this.emitComments(fields[i].loc.offset, 1);
        this.raw(1, param(fields[i]) + (i < fields.length - 1 ? ',' : ''));
      }
      this.raw(0, '}');
      return;
    }
    this.raw(0, 'type ' + t.name + ' = ' + type(t.type));
  }

  private errorDecl(e: ErrorDecl): void {
    this.emitComments(e.loc.offset, 0);
    if (e.fields.length === 0) {
      this.raw(0, 'error ' + e.name);
      return;
    }
    const commented = e.fields.some((field) => this.comments.has(field.loc.offset) || this.trailing.has(field.loc.offset));
    if (!commented) {
      this.raw(0, 'error ' + e.name + ' {');
      for (const f of e.fields) this.raw(1, param(f));
      this.raw(0, '}');
      return;
    }
    // Same rule as a record: a commented field needs a line of its own.
    this.raw(0, 'error ' + e.name + ' {');
    for (const f of e.fields) {
      this.emitComments(f.loc.offset, 1);
      this.raw(1, param(f));
    }
    this.raw(0, '}');
  }

  private enumDecl(e: { kind: string; name: string; values: string[]; valueLocs?: Loc[]; loc: Loc }): void {
    this.emitComments(e.loc.offset, 0);
    const locs = e.valueLocs ?? [];
    const commented = locs.length === e.values.length &&
      e.values.some((_, index) => this.comments.has(locs[index].offset) || this.trailing.has(locs[index].offset));
    if (!commented) {
      this.raw(0, 'enum ' + e.name + ' { ' + e.values.join(', ') + ' }');
      return;
    }
    // A commented value needs its own line, exactly like a commented field.
    this.raw(0, 'enum ' + e.name + ' {');
    for (let index = 0; index < e.values.length; index += 1) {
      this.emitComments(locs[index].offset, 1);
      this.raw(1, e.values[index] + (index < e.values.length - 1 ? ',' : ''));
    }
    this.raw(0, '}');
  }

  private service(s: ServiceNode): void {
    this.emitComments(s.loc.offset, 0);
    const head = (s.external ? 'external service ' : 'service ') + s.name + ' : ' + s.impl + ' {';
    this.raw(0, head);
    if (Object.keys(s.meta).length > 0) {
      this.raw(1, 'meta {');
      for (const [k, v] of Object.entries(s.meta)) this.raw(2, k + ': ' + quoteStr(v));
      this.raw(1, '}');
      this.blank();
    }
    const body: Array<() => void> = [];
    if (s.uses.length > 0) body.push(() => { for (const c of s.uses) this.capUse(c); });
    if (s.roles.length > 0) body.push(() => this.raw(1, 'roles: ' + s.roles.join(', ')));
    if (s.effects) body.push(() => this.effects(s.effects!));
    if (s.rules.length > 0) body.push(() => this.rules(s.rules));
    if (s.contract.length > 0) body.push(() => this.contract(s.contract));
    for (const sg of s.sagas) body.push(() => this.saga(sg));
    if (s.examples.length > 0) body.push(() => this.examples(s.examples));
    if (s.budget) body.push(() => this.budget(s.budget!));
    for (let i = 0; i < body.length; i++) {
      if (i > 0) this.blank();
      body[i]();
    }
    this.raw(0, '}');
  }

  private capUse(c: CapUse): void {
    this.emitComments(c.loc.offset, 1);
    let s = 'uses ' + c.alias + ': ' + c.capability;
    const keys = Object.keys(c.params);
    if (keys.length > 0) s += '(' + keys.map((k) => k + ': ' + expr(c.params[k])).join(', ') + ')';
    this.raw(1, s);
  }

  private effects(e: EffectsNode): void {
    this.emitComments(e.loc.offset, 1);
    this.raw(1, 'effects {');
    if (e.allow.length > 0) this.raw(2, 'allow ' + e.allow.join(', '));
    if (e.deny.length > 0) this.raw(2, 'deny ' + e.deny.join(', '));
    this.raw(1, '}');
  }

  private rules(rs: RuleNode[]): void {
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
    this.raw(1, '}');
  }

  private contract(ops: OpNode[]): void {
    this.raw(1, 'contract {');
    for (const op of ops) {
      this.blank();
      this.op(op, 2);
    }
    this.raw(1, '}');
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
    this.raw(indent, '}');
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
      const parts: string[] = [];
      if (st.call) parts.push('call: ' + st.call);
      if (st.compensate) parts.push('compensate: ' + st.compensate);
      if (st.retry !== null) parts.push('retry: ' + st.retry);
      this.raw(2, 'step ' + st.name + ' { ' + parts.join(' ') + ' }');
    }
    this.raw(1, '}');
  }

  private examples(exs: ExampleNode[]): void {
    this.raw(1, 'examples {');
    for (const ex of exs) {
      this.blank();
      this.emitComments(ex.loc.offset, 2);
      this.raw(2, 'example ' + ex.name + ' {');
      if (ex.given.length) this.section('given', ex.given, 3);
      if (ex.when.length) this.section('when', ex.when, 3);
      if (ex.then.length) this.section('then', ex.then, 3);
      this.raw(2, '}');
    }
    this.raw(1, '}');
  }

  private section(name: string, stmts: Stmt[], indent: number): void {
    this.raw(indent, name + ' {');
    for (const st of stmts) {
      this.emitComments(st.loc.offset, indent + 1);
      if (st.kind === 'let') this.raw(indent + 1, 'let ' + st.name + ' = ' + expr(st.expr));
      else this.raw(indent + 1, expr(st.expr));
    }
    this.raw(indent, '}');
  }

  private budget(b: BudgetNode): void {
    this.emitComments(b.loc.offset, 1);
    this.raw(1, 'budget {');
    for (const item of b.items) {
      let s = item.key + ': ';
      if (item.op) s += item.op + ' ';
      s += expr(item.expr);
      this.raw(2, s);
    }
    this.raw(1, '}');
  }

  private workflow(w: WorkflowNode): void {
    this.emitComments(w.loc.offset, 0);
    this.raw(0, 'workflow ' + w.name + ' {');
    if (w.trigger) this.raw(1, 'trigger ' + this.trigger(w.trigger));
    if (w.overlap) this.raw(1, 'overlap: ' + w.overlap);
    if (w.catchup) this.raw(1, 'catchup: ' + w.catchup);
    if (w.retry !== null) this.raw(1, 'retry: ' + w.retry);
    if (w.timeout) this.raw(1, 'timeout: ' + expr(w.timeout));
    for (const st of w.steps) {
      this.blank();
      this.emitComments(st.loc.offset, 1);
      let head = 'step ' + st.name + params(st.params);
      if (st.returns) head += ' -> ' + type(st.returns);
      this.raw(1, head + ' {');
      if (st.call) this.raw(2, 'call: ' + st.call);
      if (st.needs.length) this.raw(2, 'needs: ' + st.needs.join(', '));
      if (st.effects.length) this.raw(2, 'effects: ' + st.effects.join(', '));
      if (st.onFail) this.raw(2, 'onFail: ' + st.onFail);
      if (st.retry !== null) this.raw(2, 'retry: ' + st.retry);
      if (st.timeout) this.raw(2, 'timeout: ' + expr(st.timeout));
      this.raw(1, '}');
    }
    this.raw(0, '}');
  }

  private trigger(t: TriggerNode): string {
    if (t.args.length === 0) return t.kind;
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
    this.raw(0, '}');
  }

  private ui(u: UiNode): void {
    this.emitComments(u.loc.offset, 0);
    this.raw(0, 'ui ' + u.name + ' {');
    this.raw(1, 'kind: ' + u.impl);
    this.raw(1, 'route: ' + quoteStr(u.route));
    if (u.title !== null) this.raw(1, 'title: ' + quoteStr(u.title));
    if (u.layout) this.raw(1, 'layout: ' + u.layout);
    if (u.locale !== null) this.raw(1, 'locale: ' + quoteStr(u.locale));
    if (u.locales) this.raw(1, 'locales: ' + quoteStr(u.locales.join(', ')));
    if (u.theme && u.theme !== 'auto') this.raw(1, 'theme: ' + u.theme);
    if (u.render && u.render !== 'static') this.raw(1, 'render: ' + u.render);
    if (u.start) this.raw(1, 'start: ' + u.start);
    if (u.join) this.raw(1, 'join: ' + u.join);
    if (u.state) this.raw(1, 'state: ' + u.state);
    if (u.advance) this.raw(1, 'advance: ' + u.advance);
    if (u.history) this.raw(1, 'history: ' + u.history);
    if (u.send) this.raw(1, 'send: ' + u.send);
    if (u.uses.length) this.raw(1, 'uses ' + u.uses.join(', '));
    for (const s of u.slides) {
      this.emitComments(s.loc.offset, 1);
      this.raw(1, 'slide ' + quoteStr(s.title) + ' {');
      if (s.body !== null) this.raw(2, 'body: ' + quoteStr(s.body));
      this.raw(1, '}');
    }
    this.raw(0, '}');
  }
}

// ---------------- public API ----------------

export function printModule(mod: ModuleNode): string {
  return new Printer(new Map()).module(mod);
}

export function formatSource(source: string, file: string): string {
  const mod = parse(source, file);
  const comments = extractComments(source);
  const offsets = collectOffsets(mod);
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
      // The deepest node that starts on the comment's own line owns it. A
      // comment after a closing brace has no such node and is dropped.
      const line = lineOf(c.start);
      let target = -1;
      for (let i = offsets.length - 1; i >= 0; i--) {
        const o = offsets[i];
        if (o > c.start) continue;
        const oLine = lineOf(o);
        if (oLine === line) { target = o; break; }
        if (oLine < line) break;
      }
      if (target < 0) continue;
      const arr = trailing.get(target) ?? [];
      arr.push(c.text.replace(/\s+/g, ' ').trim());
      trailing.set(target, arr);
      continue;
    }
    // A leading comment belongs to the first node that starts after it ends.
    let target = -1;
    for (const o of offsets) {
      if (o >= c.end) { target = o; break; }
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
  return new Printer(leading, trailing, moduleComments, tailComments, metaTail).module(mod);
}
