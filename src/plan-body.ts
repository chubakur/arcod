import type { Expr, ModuleNode, OpNode, ServiceNode } from './ast.ts';
import { asOnce } from './check.ts';

// Derives the procedure for an operation body from the model: capabilities in
// use, effects the operation needs, rules (once/atomic) and error clauses.
// Nothing here is keyed on the operation name: the same shape produces the
// same plan.
export interface BodyPlan {
  intents: string[];
  steps: string[];
  unresolved: string[];
}

function callName(expr: Expr): string | null {
  if (expr.kind !== 'call') return null;
  const callee = expr.callee;
  if (callee.kind !== 'member') return null;
  return callee.property;
}

function assertsNonConsuming(expr: Expr): boolean {
  // on error E: store.has(id) — the message must survive a failed attempt.
  const seen = new Set<string>();
  const visit = (node: Expr) => {
    const name = callName(node);
    if (name === 'has') seen.add(name);
    if (node.kind === 'member') visit(node.object);
    if (node.kind === 'call') {
      visit(node.callee);
      for (const arg of node.args) visit(arg.value);
    }
    if (node.kind === 'unary') visit(node.operand);
    if (node.kind === 'binary') {
      visit(node.left);
      visit(node.right);
    }
    if (node.kind === 'is') visit(node.expr);
  };
  visit(expr);
  return seen.has('has');
}

function rawName(type: { kind: string; name?: string; inner?: unknown }): string | null {
  if (type.kind === 'named' && type.name) return type.name;
  if (type.kind === 'optional' && type.inner) return rawName(type.inner as { kind: string; name?: string });
  return null;
}

function resolveType(mod: ModuleNode, type: { kind: string; name?: string; inner?: unknown; union?: unknown }): string | null {
  const name = rawName(type);
  if (!name) return null;
  const decl = mod.types.find((item) => item.name === name);
  return decl ? resolveType(mod, decl.type) : name;
}

export function opEffects(mod: ModuleNode, svc: ServiceNode, op: OpNode, guarded: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (alias: string, name: string) => {
    if (out.some(([a, o]) => a === alias && o === name)) return;
    out.push([alias, name]);
  };

  const kv = svc.uses.find((use) => use.capability === 'kv' || use.capability.endsWith('.kv'))?.alias;
  const ids = svc.uses.find((use) => use.capability === 'ids' || use.capability.endsWith('.ids'))?.alias;
  const hash = svc.uses.find((use) => use.capability === 'hash' || use.capability.endsWith('.hash'))?.alias;
  const atomic = svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === op.name);
  const once = svc.rules
    .map((rule) => (rule.kind === 'invariant' ? asOnce(rule.expr) : null))
    .find((item) => item && item.op === op.name) ?? null;

  // An operation that takes an identifier reads a stored record; one without
  // it produces a new record. This is shape, not naming.
  const reads = op.params.some((param) => resolveType(mod, param.type) === 'uuid');
  if (reads) {
    if (kv) {
      add(kv, 'get');
      add(kv, 'seen');
      if (atomic || once) add(kv, 'takeIf');
    }
    if (guarded && hash) add(hash, 'verify');
  } else {
    if (ids) add(ids, 'new');
    if (kv) add(kv, 'set');
    if (guarded && hash) add(hash, 'hash');
  }

  for (const clause of op.clauses) {
    if (clause.kind !== 'pre' && clause.kind !== 'post' && clause.kind !== 'onerror') continue;
    const visit = (node: Expr) => {
      if (node.kind === 'call' && node.callee.kind === 'member' && node.callee.object.kind === 'ident') {
        add(node.callee.object.name, node.callee.property);
      }
      if (node.kind === 'member') visit(node.object);
      if (node.kind === 'call') {
        visit(node.callee);
        for (const arg of node.args) visit(arg.value);
      }
      if (node.kind === 'unary') visit(node.operand);
      if (node.kind === 'binary') {
        visit(node.left);
        visit(node.right);
      }
      if (node.kind === 'is') visit(node.expr);
    };
    visit(clause.expr);
  }

  return out;
}

export function planBody(mod: ModuleNode, svc: ServiceNode, op: OpNode): BodyPlan {
  const guarded = svc.uses.some((use) => use.capability === 'hash' || use.capability.endsWith('.hash'));
  const effects = opEffects(mod, svc, op, guarded);
  const names = new Set(effects.map(([, name]) => name));
  const errors = op.clauses
    .filter((clause) => clause.kind === 'errors')
    .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));

  const atomic = svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === op.name);
  const once = svc.rules
    .map((rule) => (rule.kind === 'invariant' ? asOnce(rule.expr) : null))
    .find((item) => item && item.op === op.name) ?? null;

  const nonConsuming = new Set(
    op.clauses
      .filter((clause) => clause.kind === 'onerror' && assertsNonConsuming(clause.expr))
      .map((clause) => (clause.kind === 'onerror' ? clause.error : '')),
  );

  const payload = op.params.find((param) => resolveType(mod, param.type) === 'bytes')
    ?? op.params.find((param) => !['id', 'password'].includes(param.name));

  const password = op.params.find((param) => param.name === 'password' || rawName(param.type) === 'Password');
  const intents: string[] = [];
  const steps: string[] = [];
  const unresolved: string[] = [];

  if (names.has('new')) {
    intents.push('generate-id');
    steps.push('id = io.new()');
  }

  if (names.has('set')) {
    intents.push('persist');
    if (!payload) {
      unresolved.push('no payload parameter to store');
    } else {
      const record = guarded && password
        ? '{b: ' + payload.name + ', h: ' + password.name + ' ? await io.hash(' + password.name + ') : null}'
        : '{b: ' + payload.name + ', h: null}';
      steps.push('await io.save(id, ' + record + ')');
      steps.push('return { result: id }');
    }
  }

  if (names.has('get') && !names.has('set')) {
    intents.push('load');
    steps.push('rec = await io.load(id)');

    const missing = errors.includes('NotFound') ? 'NotFound' : errors.includes('Gone') ? 'Gone' : null;
    const gone = errors.includes('Gone') ? 'Gone' : null;
    if (missing) {
      intents.push('missing-branch');
      steps.push(gone && missing !== gone
        ? 'if (!rec) return (await io.seen(id)) ? ' + gone + ' : ' + missing
        : 'if (!rec) return ' + missing);
    }

    if (guarded && password && names.has('verify')) {
      const verifyError = errors.find((name) => nonConsuming.has(name))
        ?? errors.find((name) => name !== 'NotFound' && name !== 'Gone');
      if (verifyError) {
        intents.push('verify');
        steps.push('if (rec.h && !(await io.verify(' + password.name + ', rec.h))) return ' + verifyError);
      } else {
        unresolved.push('password is checked but no error is declared for a wrong password');
      }
    }

    if (atomic || once) {
      intents.push('consume');
      const failure = once?.elseName ?? (errors.includes('Gone') ? 'Gone' : null);
      if (!failure) {
        unresolved.push('consume is required but the operation declares no error for an already consumed value');
      } else {
        steps.push('if (!(await io.takeIf(id, rec))) return ' + failure);
      }
    }

    steps.push('return { result: rec.b }');
  }

  if (names.has('set') && names.has('get')) {
    unresolved.push('operation both reads and writes the same record; v0.1 cannot derive one procedure');
  }

  return { intents, steps, unresolved };
}

export function planText(plan: BodyPlan): string {
  return plan.steps.length > 0 ? plan.steps.join('; ') : '(no procedure derived)';
}
