import type {
  Arg, BindNode, BudgetNode, CapUse, Clause, EnumDecl, EnvironmentNode, ErrorDecl,
  ExampleNode, Expr, EffectsNode, Loc, ModuleNode, OpNode, Param, RuleNode,
  ServiceNode, Stmt, TypeArg, TypeDecl, TypeExpr, UiNode, UseNode,
} from './ast.ts';
import { lex, locOf, type Token } from './lexer.ts';

export class ParseError extends Error {
  loc: Loc;

  constructor(message: string, loc: Loc) {
    super(message);
    this.loc = loc;
  }
}

export function parse(source: string, file = '<input>'): ModuleNode {
  return new Parser(source, file).parseModule();
}

const CLAUSE_START = new Set([
  'pre', 'post', 'on', 'errors', 'route', 'schedule', 'idempotent', 'since', 'side', 'timeout',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  private source: string;
  private file: string;

  constructor(source: string, file: string) {
    this.source = source;
    this.file = file;
    this.tokens = lex(source);
  }

  parseModule(): ModuleNode {
    const start = this.peek();
    this.expect('module');
    const name = this.expectIdent('module name').value;
    let version = '0.0.0';
    if (this.peek().kind === 'version') version = this.next().value;

    const meta: Record<string, string> = {};
    this.expect('{');
    while (!this.is('}')) {
      if (this.accept('meta')) {
        Object.assign(meta, this.parseMeta());
      } else {
        this.next();
      }
    }
    const end = this.expect('}');

    const mod: ModuleNode = {
      kind: 'module', name, version, meta, uses: [], types: [], errors: [], enums: [],
      services: [], environments: [], uis: [], file: this.file, source: this.source,
      loc: this.loc(start, end),
    };

    while (this.peek().kind !== 'eof') {
      if (this.accept('use')) { mod.uses.push(this.parseUse()); continue; }
      if (this.is('type')) { mod.types.push(this.parseTypeDecl()); continue; }
      if (this.is('error')) { mod.errors.push(this.parseErrorDecl()); continue; }
      if (this.is('enum')) { mod.enums.push(this.parseEnumDecl()); continue; }
      if (this.is('service')) { mod.services.push(this.parseService(false)); continue; }
      if (this.is('external')) { this.next(); mod.services.push(this.parseService(true)); continue; }
      if (this.is('environment')) { mod.environments.push(this.parseEnvironment()); continue; }
      if (this.is('ui')) { mod.uis.push(this.parseUi()); continue; }
      if (this.is('unknown')) { this.skipUnknown(); continue; }
      if (this.is('policy') || this.is('change')) { this.skipBlockOrLine(); continue; }
      this.error('unexpected top-level token ' + JSON.stringify(this.peek().value));
    }

    return mod;
  }

  private parseMeta(): Record<string, string> {
    const out: Record<string, string> = {};
    this.expect('{');
    while (!this.is('}')) {
      const key = this.expectIdent('meta key').value;
      this.expect(':');
      const tok = this.next();
      out[key] = tok.value;
      this.accept(',');
      this.accept(';');
    }
    this.expect('}');
    return out;
  }

  private parseUse(): UseNode {
    const start = this.tokens[this.pos - 1];
    const what = this.expectIdent('module or capability').value;
    if (what !== 'module' && what !== 'capability') this.error('expected module or capability');
    const name = this.parseQName();
    let version: string | undefined;
    if (this.peek().kind === 'version') version = this.next().value;
    return { kind: 'use', what: what as 'module' | 'capability', name, version, loc: this.loc(start, this.prev()) };
  }

  private parseTypeDecl(): TypeDecl {
    const start = this.expect('type');
    const name = this.expectIdent('type name').value;
    this.expect('=');
    const type = this.parseTypeExpr();
    return { kind: 'type', name, type, loc: this.loc(start, this.prev()) };
  }

  private parseErrorDecl(): ErrorDecl {
    const start = this.expect('error');
    const name = this.expectIdent('error name').value;
    let fields: Param[] = [];
    if (this.accept('{')) {
      while (!this.is('}')) {
        fields.push(this.parseParam());
        this.accept(',');
      }
      this.expect('}');
    }
    return { kind: 'error', name, fields, loc: this.loc(start, this.prev()) };
  }

  private parseEnumDecl(): EnumDecl {
    const start = this.expect('enum');
    const name = this.expectIdent('enum name').value;
    this.expect('{');
    const values: string[] = [];
    while (!this.is('}')) {
      values.push(this.expectIdent('enum value').value);
      this.accept(',');
    }
    this.expect('}');
    return { kind: 'enum', name, values, loc: this.loc(start, this.prev()) };
  }

  private parseTypeExpr(): TypeExpr {
    const first = this.parseTypePrimary();
    if (!this.is('|')) return first;
    const variants = [first];
    while (this.accept('|')) variants.push(this.parseTypePrimary());
    return { kind: 'union', variants, loc: this.loc2(first.loc, variants[variants.length - 1].loc) };
  }

  private parseTypePrimary(): TypeExpr {
    const start = this.peek();
    let type: TypeExpr;

    if (this.accept('{')) {
      const fields: Param[] = [];
      while (!this.is('}')) {
        fields.push(this.parseParam());
        this.accept(',');
      }
      const end = this.expect('}');
      type = { kind: 'record', fields, loc: this.loc(start, end) };
    } else if (this.accept('(')) {
      type = this.parseTypeExpr();
      this.expect(')');
    } else {
      const name = this.parseQName();
      const args: TypeArg[] = [];
      if (this.accept('<')) {
        while (!this.is('>')) {
          const argStart = this.peek();
          args.push({ value: this.parseTypeExpr(), isType: true, loc: locOf(argStart) });
          this.accept(',');
        }
        this.expect('>');
      }
      if (this.accept('(')) {
        while (!this.is(')')) {
          const argStart = this.peek();
          if (this.peek().kind === 'ident' && this.peek(1).value === ':') {
            const argName = this.next().value;
            this.expect(':');
            args.push({ name: argName, value: this.parseExpr(), loc: locOf(argStart) });
          } else {
            args.push({ value: this.parseExpr(), loc: locOf(argStart) });
          }
          this.accept(',');
        }
        this.expect(')');
      }
      type = { kind: 'named', name, args, loc: this.loc(start, this.prev()) };
    }

    while (this.accept('?')) {
      type = { kind: 'optional', inner: type, loc: this.loc(start, this.prev()) };
    }
    return type;
  }

  private parseParam(): Param {
    const start = this.peek();
    const name = this.expectIdent('parameter name').value;
    this.expect(':');
    const type = this.parseTypeExpr();
    let def: Expr | undefined;
    if (this.accept('=')) def = this.parseExpr();
    return { name, type, default: def, loc: this.loc(start, this.prev()) };
  }

  private parseService(external: boolean): ServiceNode {
    const start = this.expect('service');
    const name = this.expectIdent('service name').value;
    let impl = 'lib';
    if (this.accept(':')) impl = this.parseQName();
    this.expect('{');

    const svc: ServiceNode = {
      kind: 'service', name, impl, external, meta: {}, uses: [], contract: [],
      rules: [], effects: null, examples: [], budget: null, loc: locOf(start),
    };

    while (!this.is('}')) {
      if (this.accept('meta')) { Object.assign(svc.meta, this.parseMeta()); continue; }
      if (this.accept('uses')) { svc.uses.push(this.parseCapUse()); continue; }
      if (this.accept('contract')) { this.parseContract(svc); continue; }
      if (this.accept('rules')) { this.parseRules(svc); continue; }
      if (this.accept('effects')) { svc.effects = this.parseEffects(); continue; }
      if (this.accept('examples')) { this.parseExamples(svc); continue; }
      if (this.accept('budget')) { svc.budget = this.parseBudget(); continue; }
      if (this.is('lifecycle')) { this.next(); this.skipBalanced('{'); continue; }
      if (this.is('hint') || this.is('impl') || this.is('unknown')) { this.skipBlockOrLine(); continue; }
      this.error('unexpected member ' + JSON.stringify(this.peek().value));
    }
    const end = this.expect('}');
    svc.loc = this.loc(start, end);
    return svc;
  }

  private parseCapUse(): CapUse {
    const start = this.peek();
    const alias = this.expectIdent('alias').value;
    this.expect(':');
    const capability = this.parseQName();
    const params: Record<string, Expr> = {};
    if (this.accept('(')) {
      while (!this.is(')')) {
        const key = this.expectIdent('capability parameter').value;
        if (this.accept(':')) params[key] = this.parseExpr();
        this.accept(',');
      }
      this.expect(')');
    }
    return { kind: 'uses', alias, capability, params, loc: this.loc(start, this.prev()) };
  }

  private parseContract(svc: ServiceNode): void {
    this.expect('{');
    while (!this.is('}')) {
      const isPublic = this.accept('public');
      if (this.is('op')) {
        this.next();
        svc.contract.push(this.parseOp('op', isPublic));
        continue;
      }
      if (this.is('job')) {
        this.next();
        svc.contract.push(this.parseOp('job', false));
        continue;
      }
      this.error('expected op or job');
    }
    this.expect('}');
  }

  private parseOp(kind: 'op' | 'job', isPublic: boolean): OpNode {
    const start = this.prev();
    const name = this.expectIdent('operation name').value;
    const params = this.parseParams();
    let returns: TypeExpr | null = null;
    if (this.accept('->')) returns = this.parseTypeExpr();
    const clauses: Clause[] = [];
    this.expect('{');
    while (!this.is('}')) {
      if (this.accept(';')) continue;
      if (this.accept('idempotent')) { clauses.push({ kind: 'idempotent', loc: locOf(this.prev()) }); continue; }
      const key = this.expectIdent('clause').value;
      if (key === 'on') {
        this.expect('error');
        const error = this.expectIdent('error name').value;
        this.expect(':');
        clauses.push({ kind: 'onerror', error, expr: this.parseExpr(), loc: locOf(this.prev()) });
        continue;
      }
      if (key === 'pre' || key === 'post') {
        this.expect(':');
        clauses.push({ kind: key, expr: this.parseExpr(), loc: locOf(this.prev()) });
        continue;
      }
      if (key === 'effects') {
        this.expect(':');
        const effects: string[] = [];
        while (true) {
          const alias = this.expectIdent('effect alias').value;
          this.expect('.');
          const effect = this.expectIdent('effect name').value;
          effects.push(alias + '.' + effect);
          if (!this.accept(',')) break;
        }
        clauses.push({ kind: 'effects', names: effects, loc: locOf(this.prev()) });
        continue;
      }
      if (key === 'errors') {
        this.expect(':');
        const names: string[] = [];
        if (this.is('none')) { this.next(); }
        else {
          while (true) {
            names.push(this.expectIdent('error name').value);
            if (!this.accept(',')) break;
          }
        }
        clauses.push({ kind: 'errors', names, loc: locOf(this.prev()) });
        continue;
      }
      if (key === 'route' || key === 'schedule' || key === 'since') {
        this.expect(':');
        const tok = this.next();
        clauses.push({ kind: key, value: tok.value, loc: locOf(tok) });
        continue;
      }
      if (key === 'set') { this.expect(':'); this.parseExpr(); continue; }
      this.error('unknown op clause ' + JSON.stringify(key));
    }
    const end = this.expect('}');
    return { kind, name, isPublic, params, returns, clauses, loc: this.loc(start, end) };
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    this.expect('(');
    while (!this.is(')')) {
      params.push(this.parseParam());
      this.accept(',');
    }
    this.expect(')');
    return params;
  }

  private parseRules(svc: ServiceNode): void {
    this.expect('{');
    while (!this.is('}')) {
      if (this.accept('invariant')) {
        const name = this.parseQName();
        this.expect(':');
        const expr = this.parseExpr();
        svc.rules.push({ kind: 'invariant', name, expr, loc: locOf(this.prev()) });
        continue;
      }
      if (this.accept('atomic')) {
        const name = this.parseQName();
        this.expect('{');
        const steps: string[] = [];
        while (!this.is('}')) {
          steps.push(this.expectIdent('step').value);
          this.accept(';');
          this.accept(',');
        }
        this.expect('}');
        svc.rules.push({ kind: 'atomic', name, steps, loc: locOf(this.prev()) });
        continue;
      }
      if (this.accept('ordering')) {
        this.expect('{');
        const pairs: Array<[string, string]> = [];
        while (!this.is('}')) {
          const a = this.expectIdent('operation').value;
          this.expect('before');
          const b = this.expectIdent('operation').value;
          pairs.push([a, b]);
          this.accept(';');
        }
        this.expect('}');
        svc.rules.push({ kind: 'ordering', pairs, loc: locOf(this.prev()) });
        continue;
      }
      if (this.accept('unique')) {
        const path = this.parseQName();
        svc.rules.push({ kind: 'unique', path, loc: locOf(this.prev()) });
        continue;
      }
      this.error('unknown rule ' + JSON.stringify(this.peek().value));
    }
    this.expect('}');
  }

  private parseEffects(): EffectsNode {
    const start = this.prev();
    this.expect('{');
    const allow: string[] = [];
    const deny: string[] = [];
    let target: string[] = allow;
    while (!this.is('}')) {
      if (this.accept('allow')) { target = allow; continue; }
      if (this.accept('deny')) { target = deny; continue; }
      target.push(this.parseQName());
      this.accept(',');
    }
    this.expect('}');
    return { kind: 'effects', allow, deny, loc: this.loc(start, this.prev()) };
  }

  private parseExamples(svc: ServiceNode): void {
    this.expect('{');
    while (!this.is('}')) {
      this.expect('example');
      const name = this.expectIdent('example name').value;
      const example: ExampleNode = { kind: 'example', name, given: [], when: [], then: [], loc: locOf(this.prev()) };
      this.expect('{');
      while (!this.is('}')) {
        const section = this.expectIdent('example section').value;
        if (section !== 'given' && section !== 'when' && section !== 'then') {
          this.error('expected given, when or then, got ' + section);
        }
        this.expect('{');
        const stmts: Stmt[] = [];
        while (!this.is('}')) {
          if (this.accept('let')) {
            const stmtStart = this.prev();
            const varName = this.expectIdent('variable name').value;
            this.expect('=');
            stmts.push({ kind: 'let', name: varName, expr: this.parseExpr(), loc: locOf(stmtStart) });
          } else {
            const stmtStart = this.peek();
            stmts.push({ kind: 'expr', expr: this.parseExpr(), loc: locOf(stmtStart) });
          }
          this.accept(';');
        }
        this.expect('}');
        example[section as 'given' | 'when' | 'then'] = stmts;
      }
      this.expect('}');
      svc.examples.push(example);
    }
    this.expect('}');
  }

  private parseBudget(): BudgetNode {
    const start = this.prev();
    this.expect('{');
    const items: Array<{ key: string; op: string | null; expr: Expr; loc: Loc }> = [];
    while (!this.is('}')) {
      const key = this.expectIdent('budget key').value;
      this.expect(':');
      let op: string | null = null;
      if (this.is('<=') || this.is('<') || this.is('>=') || this.is('>') || this.is('==')) {
        op = this.next().value;
      }
      const expr = this.parseExpr();
      items.push({ key, op, expr, loc: locOf(this.prev()) });
      this.accept(';');
    }
    this.expect('}');
    return { kind: 'budget', items, loc: this.loc(start, this.prev()) };
  }

  private parseUi(): UiNode {
    const start = this.expect('ui');
    const name = this.expectIdent('ui name').value;
    const ui: UiNode = { kind: 'ui', name, impl: 'spa', route: '/', title: null, uses: [], loc: locOf(start) };
    this.expect('{');
    while (!this.is('}')) {
      const key = this.expectIdent('ui property').value;
      if (key === 'uses') {
        while (true) {
          ui.uses.push(this.parseQName());
          if (!this.accept(',')) break;
        }
        this.accept(';');
        continue;
      }
      this.expect(':');
      if (key === 'kind' || key === 'impl') {
        ui.impl = this.expectIdent('ui kind').value;
      } else if (key === 'route') {
        ui.route = this.next().value;
      } else if (key === 'title') {
        ui.title = this.next().value;
      } else {
        this.next();
      }
      this.accept(';');
    }
    const end = this.expect('}');
    ui.loc = this.loc(start, end);
    return ui;
  }

  private parseEnvironment(): EnvironmentNode {
    const start = this.expect('environment');
    const name = this.expectIdent('environment name').value;
    this.expect('{');
    const binds: BindNode[] = [];
    let deploy: DeployNode | null = null;
    while (!this.is('}')) {
      if (this.accept('bind')) {
        const bindStart = this.prev();
        const alias = this.expectIdent('alias').value;
        this.expect('->');
        const provider = this.parseQName();
        const args: Record<string, Expr> = {};
        if (this.accept('(')) {
          while (!this.is(')')) {
            const key = this.expectIdent('binding argument').value;
            this.expect(':');
            args[key] = this.parseExpr();
            this.accept(',');
          }
          this.expect(')');
        }
        const guarantees: string[] = [];
        if (this.accept('guarantees')) {
          this.expect('[');
          while (!this.is(']')) { guarantees.push(this.expectIdent('guarantee').value); this.accept(','); }
          this.expect(']');
        }
        binds.push({ kind: 'bind', alias, provider, args, guarantees, loc: this.loc(bindStart, this.prev()) });
        continue;
      }
      if (this.accept('deploy')) {
        const deployStart = this.prev();
        const provider = this.expectIdent('deploy provider').value;
        const args: Record<string, Expr> = {};
        if (this.accept('(')) {
          while (!this.is(')')) {
            const key = this.expectIdent('deploy argument').value;
            this.expect(':');
            args[key] = this.parseExpr();
            this.accept(',');
          }
          this.expect(')');
        }
        deploy = { kind: 'deploy', provider, args, loc: this.loc(deployStart, this.prev()) };
        continue;
      }
      this.error('unexpected environment member ' + JSON.stringify(this.peek().value));
    }
    const end = this.expect('}');
    return { kind: 'environment', name, binds, deploy, loc: this.loc(start, end) };
  }

  // ---------- expressions ----------

  parseExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.is('||')) {
      const op = this.next().value;
      left = this.binary(op, left, this.parseAnd());
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.is('&&')) {
      const op = this.next().value;
      left = this.binary(op, left, this.parseEquality());
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseCompare();
    while (this.is('==') || this.is('!=') || this.is('is')) {
      const op = this.next().value;
      if (op === 'is') {
        const errName = this.expectIdent('error name').value;
        left = { kind: 'is', expr: left, error: errName, loc: this.locOfList(left) };
        continue;
      }
      left = this.binary(op, left, this.parseCompare());
    }
    return left;
  }

  private parseCompare(): Expr {
    let left = this.parseAdd();
    while (this.is('<') || this.is('>') || this.is('<=') || this.is('>=') || this.is('in')) {
      const op = this.next().value;
      left = this.binary(op, left, this.parseAdd());
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.is('+') || this.is('-')) {
      const op = this.next().value;
      left = this.binary(op, left, this.parseMul());
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.next().value;
      left = this.binary(op, left, this.parseUnary());
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.is('!') || this.is('-')) {
      const start = this.peek();
      const op = this.next().value;
      return { kind: 'unary', op, operand: this.parseUnary(), loc: this.locOfList(start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parseAtom();
    while (true) {
      if (this.accept('.')) {
        const prop = this.expectIdent('property').value;
        expr = { kind: 'member', object: expr, property: prop, loc: this.locOfList(expr) };
        continue;
      }
      if (this.is('(')) {
        const args = this.parseArgs();
        expr = { kind: 'call', callee: expr, args, loc: this.locOfList(expr) };
        continue;
      }
      if (this.accept('[')) {
        const index = this.parseExpr();
        this.expect(']');
        expr = { kind: 'call', callee: { kind: 'member', object: expr, property: '[]', loc: this.locOfList(expr) }, args: [{ value: index, loc: this.locOfList(index) }], loc: this.locOfList(expr) };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseArgs(): Arg[] {
    const args: Arg[] = [];
    this.expect('(');
    while (!this.is(')')) {
      const start = this.peek();
      if (this.peek().kind === 'ident' && this.peek(1).value === ':') {
        const name = this.next().value;
        this.expect(':');
        args.push({ name, value: this.parseExpr(), loc: locOf(start) });
      } else {
        args.push({ value: this.parseExpr(), loc: locOf(start) });
      }
      this.accept(',');
    }
    this.expect(')');
    return args;
  }

  private parseAtom(): Expr {
    const tok = this.peek();
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'literal', value: tok.value, raw: tok.raw, loc: locOf(tok) };
    }
    if (tok.kind === 'number') {
      this.next();
      const m = /^([0-9.]+)([a-zA-Z]+)?$/.exec(tok.value);
      if (m && m[2]) {
        return { kind: 'duration', value: Number(m[1]), unit: m[2], loc: locOf(tok) };
      }
      return { kind: 'literal', value: Number(tok.value), raw: tok.raw, loc: locOf(tok) };
    }
    if (tok.kind === 'ident') {
      if (tok.value === 'true' || tok.value === 'false') {
        this.next();
        return { kind: 'literal', value: tok.value === 'true', raw: tok.value, loc: locOf(tok) };
      }
      if (tok.value === 'null') {
        this.next();
        return { kind: 'literal', value: null, raw: 'null', loc: locOf(tok) };
      }
      this.next();
      return { kind: 'ident', name: tok.value, loc: locOf(tok) };
    }
    if (this.accept('(')) {
      const expr = this.parseExpr();
      this.expect(')');
      return expr;
    }
    this.error('unexpected token in expression ' + JSON.stringify(tok.value));
  }

  private binary(op: string, left: Expr, right: Expr): Expr {
    return { kind: 'binary', op, left, right, loc: this.loc2(left.loc, right.loc) };
  }

  // ---------- helpers ----------

  private parseQName(): string {
    let name = this.expectIdent('name').value;
    while (this.is('.') && this.peek(1).kind === 'ident') {
      this.next();
      name += '.' + this.next().value;
    }
    return name;
  }

  private skipUnknown(): void {
    this.expect('unknown');
    this.expectIdent('unknown id');
    if (this.is('{')) this.skipBalanced('{');
  }

  private skipBlockOrLine(): void {
    this.next();
    if (this.is('{')) { this.skipBalanced('{'); return; }
    while (this.peek().kind !== 'eof' && !this.is('}')) this.next();
  }

  private skipBalanced(open: string): void {
    const close = open === '{' ? '}' : ')';
    this.expect(open);
    let depth = 1;
    while (depth > 0 && this.peek().kind !== 'eof') {
      const tok = this.next();
      if (tok.value === open) depth++;
      else if (tok.value === close) depth--;
    }
  }

  private peek(offset = 0): Token { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  private next(): Token { return this.tokens[Math.min(this.pos++, this.tokens.length - 1)]; }
  private prev(): Token { return this.tokens[Math.max(0, this.pos - 1)]; }
  private is(value: string): boolean { const t = this.peek(); return t.kind !== 'eof' && t.value === value; }
  private accept(value: string): boolean { if (!this.is(value)) return false; this.pos++; return true; }

  private expect(value: string): Token {
    if (!this.is(value)) this.error('expected ' + JSON.stringify(value) + ', got ' + JSON.stringify(this.peek().value));
    return this.next();
  }

  private expectIdent(what: string): Token {
    const tok = this.peek();
    if (tok.kind !== 'ident') this.error('expected ' + what + ', got ' + JSON.stringify(tok.value));
    this.pos++;
    return tok;
  }

  private error(message: string): never {
    throw new ParseError(message, locOf(this.peek()));
  }

  private loc(start: Token, end: Token): Loc {
    const a = locOf(start);
    const b = locOf(end);
    return { ...a, endLine: b.endLine, endCol: b.endCol, end: b.end };
  }

  private loc2(a: Loc, b: Loc): Loc {
    return { ...a, endLine: b.endLine, endCol: b.endCol, end: b.end };
  }

  private locOfList(expr: Expr | Token): Loc {
    return 'kind' in expr ? expr.loc : locOf(expr);
  }
}
