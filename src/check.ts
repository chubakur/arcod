import type { Diagnostic } from './diagnostics.ts';
import type { Expr, Loc, ModuleNode, OpNode, ServiceNode } from './ast.ts';

const WRITE_OPS = new Set(['set', 'del', 'put', 'push', 'incr', 'decr', 'update', 'write', 'delete']);
const FORBIDDEN_IN_MODEL = ['redis', 'postgres', 'postgresql', 'dynamodb', 'mysql', 'mongodb', 'localhost', '127.0.0.1'];

export interface CheckOptions {
  environment?: string;
}

export function check(mod: ModuleNode, options: CheckOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const env = options.environment
    ? mod.environments.find((e) => e.name === options.environment)
    : mod.environments[0];
  const bound = new Map<string, string>();
  for (const bind of env?.binds ?? []) bound.set(bind.alias, bind.provider);

  for (const svc of mod.services) {
    if (svc.external) continue;
    const sourceSlice = mod.source.slice(svc.loc.offset, svc.loc.end);
    const aliases = new Set(svc.uses.map((u) => u.alias));

    // A003 — provider, host or secret mentioned in the model
    for (const word of FORBIDDEN_IN_MODEL) {
      if (sourceSlice.toLowerCase().includes(word)) {
        diags.push(diag('A003', 'error', mod.file, svc.loc, 'services', `провайдер или хост ${word} упомянут в модели`, 'перенесите привязку в environment'));
      }
    }

    // A002 — capability is not bound
    for (const use of svc.uses) {
      if (!env) {
        diags.push(diag('A002', 'error', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `возможность ${use.capability} не привязана: environment отсутствует`, 'добавьте environment с bind ' + use.alias));
      } else if (!bound.has(use.alias)) {
        diags.push(diag('A002', 'error', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `возможность ${use.capability} не привязана в environment ${env.name}`, `добавьте bind ${use.alias} -> <provider>`));
      }
    }

    // A009 — duplicate alias
    const seen = new Set<string>();
    for (const use of svc.uses) {
      if (seen.has(use.alias)) {
        diags.push(diag('A009', 'error', mod.file, use.loc, `services.${svc.name}.uses`, `алиас ${use.alias} объявлен дважды`));
      }
      seen.add(use.alias);
    }

    // Collect capability calls from every expression in the service
    const uses = collectCapabilityUses(svc, aliases);

    // A004 — effect used but not allowed
    for (const use of uses) {
      if (!svc.effects || !isAllowed(svc.effects.allow, use.alias, use.op)) {
        diags.push(diag('A004', 'error', mod.file, use.loc, `services.${svc.name}.effects`, `эффект ${use.alias}.${use.op} не разрешён`, `добавьте ${use.alias}.${use.op} в allow`));
      }
    }

    // A005 — write call inside an invariant
    for (const rule of svc.rules) {
      if (rule.kind !== 'invariant') continue;
      walkExpr(rule.expr, (expr) => {
        if (expr.kind !== 'call') return;
        const call = asCapabilityCall(expr, aliases);
        if (call && WRITE_OPS.has(call.op)) {
          diags.push(diag('A005', 'error', mod.file, expr.loc, `services.${svc.name}.rules.${rule.name}`, `write-вызов ${call.alias}.${call.op} в инварианте`, 'инварианты описывают наблюдения, а не изменения'));
        }
      });
    }

    // W011 — declared capability never used
    const usedAliases = new Set(uses.map((u) => u.alias));
    for (const use of svc.uses) {
      if (!usedAliases.has(use.alias) && !mentionsBareAlias(svc, use.alias)) {
        diags.push(diag('W011', 'warning', mod.file, use.loc, `services.${svc.name}.uses.${use.alias}`, `возможность ${use.capability} объявлена, но не используется`));
      }
    }

    // A007 — declared error is neither handled nor asserted
    const asserted = collectAssertedErrors(svc);
    const handled = collectHandledErrors(svc);
    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      for (const errorName of errorNames(op)) {
        if (!asserted.has(errorName) && !handled.has(errorName)) {
          diags.push(diag('A007', 'error', mod.file, op.loc, `services.${svc.name}.contract.${op.name}.errors`, `ошибка ${errorName} объявлена, но не обработана`, `добавьте on error ${errorName} или пример с ${errorName}`));
        }
      }
    }

    // W012 — operation without examples
    const mentioned = collectMentionedOps(svc);
    for (const op of svc.contract) {
      if (op.kind === 'job') continue;
      if (!mentioned.has(op.name)) {
        diags.push(diag('W012', 'warning', mod.file, op.loc, `services.${svc.name}.contract.${op.name}`, `операция ${op.name} не покрыта примерами`));
      }
    }

    // W013 — no budget
    if (!svc.budget) {
      diags.push(diag('W013', 'warning', mod.file, svc.loc, `services.${svc.name}`, 'бюджет не задан', 'добавьте budget с latency или cost'));
    }

    // A008 — budget metric without a comparison
    for (const item of svc.budget?.items ?? []) {
      const needsMetric = item.key === 'latency' || item.key === 'cost';
      if (needsMetric && !(item.expr.kind === 'binary' && ['<=', '<', '>=', '>', '=='].includes(item.expr.op))) {
        diags.push(diag('A008', 'error', mod.file, item.loc, `services.${svc.name}.budget.${item.key}`, 'бюджет без метрики или единицы'));
      }
    }

    // A010 — ordering cycle
    for (const rule of svc.rules) {
      if (rule.kind !== 'ordering') continue;
      const cycle = findCycle(rule.pairs);
      if (cycle) {
        diags.push(diag('A010', 'error', mod.file, rule.loc, `services.${svc.name}.rules.ordering`, 'цикл в ordering: ' + cycle.join(' -> ')));
      }
    }
  }

  // A007 also applies to errors declared at module level but never used anywhere.
  const allText = mod.source;
  for (const err of mod.errors) {
    const mentions = allText.split(err.name).length - 1;
    if (mentions <= 1) {
      diags.push(diag('W015', 'warning', mod.file, err.loc, `errors.${err.name}`, `ошибка ${err.name} объявлена, но нигде не используется`));
    }
  }

  return sortDiagnostics(diags);
}

function diag(code: string, severity: 'error' | 'warning', file: string, loc: Loc, path: string, message: string, hint?: string): Diagnostic {
  return {
    code, severity, message, file, path, hint,
    range: { line: loc.line, col: loc.col, endLine: loc.endLine, endCol: loc.endCol },
  };
}

function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  return diags.sort((a, b) =>
    a.file.localeCompare(b.file) || a.range.line - b.range.line || a.range.col - b.range.col || a.code.localeCompare(b.code));
}

function errorNames(op: OpNode): string[] {
  const clause = op.clauses.find((c) => c.kind === 'errors');
  return clause && clause.kind === 'errors' ? clause.names : [];
}

function isAllowed(allow: string[], alias: string, op: string): boolean {
  return allow.includes(alias + '.' + op) || allow.includes(alias + '.*');
}

export function walkExpr(expr: Expr, fn: (expr: Expr) => void): void {
  fn(expr);
  switch (expr.kind) {
    case 'member': walkExpr(expr.object, fn); break;
    case 'call':
      walkExpr(expr.callee, fn);
      for (const arg of expr.args) walkExpr(arg.value, fn);
      break;
    case 'unary': walkExpr(expr.operand, fn); break;
    case 'binary': walkExpr(expr.left, fn); walkExpr(expr.right, fn); break;
    case 'is': walkExpr(expr.expr, fn); break;
    default: break;
  }
}

interface CapCall { alias: string; op: string; loc: Loc }

function asCapabilityCall(expr: Expr, aliases: Set<string>): CapCall | null {
  if (expr.kind !== 'call' || expr.callee.kind !== 'member' || expr.callee.object.kind !== 'ident') return null;
  const alias = expr.callee.object.name;
  if (!aliases.has(alias)) return null;
  return { alias, op: expr.callee.property, loc: expr.loc };
}

function collectCapabilityUses(svc: ServiceNode, aliases: Set<string>): CapCall[] {
  const out: CapCall[] = [];
  const visit = (expr: Expr) => {
    walkExpr(expr, (e) => {
      const call = asCapabilityCall(e, aliases);
      if (call) out.push(call);
    });
  };
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'pre' || clause.kind === 'post' || clause.kind === 'onerror') visit(clause.expr);
    }
  }
  for (const rule of svc.rules) {
    if (rule.kind === 'invariant') visit(rule.expr);
  }
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.kind === 'let' ? stmt.expr : stmt.expr);
    }
  }
  return out;
}

function mentionsBareAlias(svc: ServiceNode, alias: string): boolean {
  let found = false;
  const visit = (expr: Expr) => walkExpr(expr, (e) => {
    if (e.kind === 'call' && e.callee.kind === 'ident' && e.callee.name === alias) found = true;
  });
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'pre' || clause.kind === 'post' || clause.kind === 'onerror') visit(clause.expr);
    }
  }
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.expr);
    }
  }
  return found;
}

function collectAssertedErrors(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) {
        walkExpr(stmt.expr, (e) => {
          if (e.kind === 'is') out.add(e.error);
        });
      }
    }
  }
  return out;
}

function collectHandledErrors(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind === 'onerror') out.add(clause.error);
    }
  }
  return out;
}

function collectMentionedOps(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  const visit = (expr: Expr) => walkExpr(expr, (e) => {
    if (e.kind === 'call' && e.callee.kind === 'ident') out.add(e.callee.name);
  });
  for (const example of svc.examples) {
    for (const section of [example.given, example.when, example.then]) {
      for (const stmt of section) visit(stmt.expr);
    }
  }
  return out;
}

function findCycle(pairs: Array<[string, string]>): string[] | null {
  const graph = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    if (!graph.has(a)) graph.set(a, []);
    graph.get(a)!.push(b);
  }
  const state = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (!state.has(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    state.set(node, 2);
    stack.pop();
    return null;
  };

  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}
