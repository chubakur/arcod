import { createHash } from 'node:crypto';
import type { Expr, ModuleNode, OpNode, ServiceNode, TypeExpr } from './ast.ts';
import { buildPlan } from './plan.ts';
import { isGuarded, pickService, routeOf } from './emit/service.ts';
import { signatureFor, shortFor } from './capabilities.ts';
import { opEffects, payloadOf, planBody, planText } from './plan-body.ts';

export interface PromptTask {
  id: string;
  op: string;
  file: string;
  prompt: string;
  tokens: number;
  sha256: string;
  unresolved: string[];
}

export interface PromptSet {
  module: string;
  version: string;
  modelHash: string;
  budget: number;
  tasks: PromptTask[];
  overBudget: string[];
  unresolved: string[];
}

export interface PromptOptions {
  budget?: number;
  format?: 'compact' | 'full';
}

export function estimateTokens(text: string): number {
  // Deliberately simple and stable: 4 characters per token, rounded up.
  return Math.ceil(text.length / 4);
}

export function exprText(expr: Expr): string {
  switch (expr.kind) {
    case 'literal':
      return expr.raw;
    case 'duration':
      return expr.value + expr.unit;
    case 'ident':
      return expr.name;
    case 'member':
      return exprText(expr.object) + '.' + expr.property;
    case 'call':
      return exprText(expr.callee) + '(' + expr.args.map((arg) => (arg.name ? arg.name + ': ' : '') + exprText(arg.value)).join(', ') + ')';
    case 'unary':
      return expr.op + exprText(expr.operand);
    case 'binary':
      return exprText(expr.left) + ' ' + expr.op + ' ' + exprText(expr.right);
    case 'is':
      return exprText(expr.expr) + ' is ' + expr.error;
    default:
      return '';
  }
}

export function typeText(type: TypeExpr): string {
  switch (type.kind) {
    case 'optional':
      return typeText(type.inner) + '?';
    case 'union':
      return type.variants.map(typeText).join(' | ');
    case 'record':
      return '{ ' + type.fields.map((field) => field.name + ': ' + typeText(field.type)).join(', ') + ' }';
    case 'named': {
      if (type.args.length === 0) return type.name;
      const args = type.args.map((arg) =>
        (arg.name ? arg.name + ': ' : '') + (arg.isType ? typeText(arg.value as TypeExpr) : exprText(arg.value as Expr)),
      );
      return type.name + '(' + args.join(', ') + ')';
    }
    default:
      return '';
  }
}

// Wire types are what the body sees: identifiers and text payloads are strings.
const WIRE: Record<string, string> = {
  uuid: 'string',
  bytes: 'string',
  string: 'string',
  number: 'number',
  boolean: 'boolean',
};

export function wireType(type: TypeExpr, named: Map<string, TypeExpr>): string {
  if (type.kind === 'optional') return wireType(type.inner, named) + ' | null';
  if (type.kind === 'named') {
    const base = named.get(type.name);
    if (base) return wireType(base, named);
    return WIRE[type.name] ?? 'string';
  }
  return 'unknown';
}

function aliasMap(svc: ServiceNode): Array<[string, string]> {
  return svc.uses.map((use) => [use.alias + '.', 'io.'] as [string, string]);
}

function contractText(expr: Expr, svc: ServiceNode): string {
  let text = exprText(expr);
  for (const [from, to] of aliasMap(svc)) text = text.split(from).join(to);
  return text;
}

function ioLines(svc: ServiceNode): string[] {
  const allowed = svc.effects?.allow ?? [];
  const capabilityOf = new Map(svc.uses.map((use) => [use.alias, use.capability]));
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (signature: string, op: string) => {
    if (seen.has(op)) return;
    seen.add(op);
    lines.push('io.' + signature);
  };

  for (const entry of allowed) {
    const [alias, op] = entry.split('.');
    if (!alias || !op) continue;
    const capability = capabilityOf.get(alias) ?? alias;
    const signature = signatureFor(capability, op);
    push(signature ?? op + '(...) — no signature registered', op);
  }

  const kv = svc.uses.find((use) => use.capability === 'kv' || use.capability.endsWith('.kv'));
  if (kv) {
    const atomic = svc.rules.some((rule) => rule.kind === 'atomic');
    if (atomic) push(signatureFor('kv', 'takeIf')!, 'takeIf');
    push(signatureFor('kv', 'seen')!, 'seen');
  }
  return lines;
}

function storageLines(svc: ServiceNode, guarded: boolean): string[] {
  const usesKv = svc.uses.some((use) => use.capability === 'kv' || use.capability.endsWith('.kv'));
  if (!usesKv) return [];
  const lines = ['io owns key layout, prefixes and TTL: pass ids, never keys.'];
  if (guarded) {
    lines.push('stored value = JSON { b: string, h: string | null }', 'h is a salted password hash, null when the message is open.');
  } else {
    lines.push('stored value = the message text as is.');
  }
  return lines;
}

function taskFor(mod: ModuleNode, svc: ServiceNode, op: OpNode, guarded: boolean): PromptTask {
  const fence = '```';
  const plan = buildPlan(mod);
  const planTask = plan.tasks.find((task) => task.kind === 'implement' && task.service === svc.name && task.op === op.name);
  const named = new Map(mod.types.map((decl) => [decl.name, decl.type]));
  const id = planTask?.id ?? 'impl.' + svc.name + '.' + op.name;
  const route = routeOf(op) ?? '';
  const errors = op.clauses
    .filter((clause) => clause.kind === 'errors')
    .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));

  const inputFields = op.params.map((param) => param.name + ': ' + wireType(param.type, named));
  const resultWire = op.returns ? wireType(op.returns, named) : 'void';
  const returns = errors.length
    ? '{ result: ' + resultWire + ' } | { error: ' + errors.map((name) => '"' + name + '"').join(' | ') + ' }'
    : '{ result: ' + resultWire + ' }';

  const contract = op.clauses
    .map((clause) => {
      if (clause.kind === 'pre') return 'pre: ' + contractText(clause.expr, svc);
      if (clause.kind === 'post') return 'post: ' + contractText(clause.expr, svc);
      if (clause.kind === 'onerror') return 'on error ' + clause.error + ': ' + contractText(clause.expr, svc);
      return '';
    })
    .filter(Boolean);

  const bodyPlan = planBody(mod, svc, op);

  // Only the rules that concern this operation: a create prompt must not
  // carry read's invariants.
  const opWord = new RegExp('\\b' + op.name + '\\b');
  const rules = svc.rules
    .map((rule) =>
      rule.kind === 'invariant'
        ? 'invariant ' + rule.name + ': ' + contractText(rule.expr, svc)
        : rule.kind === 'atomic'
          ? 'atomic ' + rule.name + ' { ' + rule.steps.join('; ') + ' }'
          : '',
    )
    .filter((text) => text && opWord.test(text));

  const lines = [
    '# Task ' + id,
    'module ' + mod.name + '@' + mod.version,
    'service ' + svc.name,
    'operation ' + op.name + ' (http)',
    'route ' + route,
    '',
    'Write exactly one file: impl/' + op.name + '.mjs',
    'It exports one function and nothing else. No imports.',
    '',
    '## Signature',
    'export async function ' + op.name + '(input, io) { /* ... */ }',
    'input: { ' + inputFields.join(', ') + ' }',
    'returns: ' + returns,
    '',
  ];

  if (contract.length > 0) lines.push('## Contract', ...contract.map((item) => '- ' + item), '');
  if (rules.length > 0) lines.push('## Rules of the service', ...rules.map((item) => '- ' + item), '');

  const io = ioLines(svc);
  lines.push('## io (use only these)', ...(io.length > 0 ? io.map((item) => '- ' + item) : ['- (none)']), '');

  const storage = storageLines(svc, guarded);
  if (storage.length > 0) lines.push('## Storage', ...storage.map((item) => '- ' + item), '');

  lines.push(
    '## Constraints',
    '- Do not write HTTP, statuses or headers: the compiler owns them.',
    '- Return { error: "Name" } for declared errors; return { result } on success.',
    '- Keep the body under 40 lines. No comments except a one-line summary.',
    '',
    '## Output',
    'Reply with exactly one ' + fence + 'js block containing the whole file, and nothing else.',
    '',
  );

  const prompt = lines.join('\n');
  return {
    id,
    op: op.name,
    file: 'impl/' + op.name + '.mjs',
    prompt,
    tokens: estimateTokens(prompt),
    sha256: createHash('sha256').update(prompt).digest('hex'),
    unresolved: bodyPlan.unresolved,
  };
}

export function buildPrompts(mod: ModuleNode, options: PromptOptions = {}): PromptSet {
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to build prompts for');
  const budget = options.budget ?? 1600;
  const guarded = isGuarded(svc);
  const format = options.format ?? 'compact';
  const tasks = svc.contract
    .filter((op) => op.kind === 'op')
    .map((op) => (format === 'full' ? taskFor(mod, svc, op, guarded) : compactTask(mod, svc, op, guarded)))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    module: mod.name,
    version: mod.version,
    modelHash: buildPlan(mod).modelHash,
    budget,
    tasks,
    overBudget: tasks.filter((task) => task.tokens > budget).map((task) => task.id),
    unresolved: tasks
      .filter((task) => task.unresolved.length > 0)
      .map((task) => task.id + ': ' + task.unresolved.join('; ')),
  };
}

function numberArg(value: Expr | TypeExpr): number | null {
  if (value.kind === 'literal' && typeof value.value === 'number') return value.value;
  if (value.kind === 'duration') {
    const unit = value.unit.toLowerCase();
    const scale = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : unit === 's' ? 1000 : 1;
    return value.value * scale;
  }
  return null;
}

function limitComment(type: TypeExpr, named: Map<string, TypeExpr>): string {
  const resolved = type.kind === 'optional' ? type.inner : type;
  const actual = resolved.kind === 'named' ? named.get(resolved.name) ?? resolved : resolved;
  if (actual.kind !== 'named') return '';
  const min = actual.args.find((arg) => arg.name === 'min');
  const max = actual.args.find((arg) => arg.name === 'max');
  if (!min && !max) return '';
  const lo = min ? numberArg(min.value) : null;
  const hi = max ? numberArg(max.value) : null;
  const unit = actual.name === 'bytes' ? 'bytes' : 'chars';
  const left = lo === null ? '' : String(lo);
  const right = hi === null ? '' : String(hi);
  return ' /* ' + (lo === null ? right : right ? left + '..' + right : '>=' + left) + ' ' + unit + ' */';
}

function compactTask(mod: ModuleNode, svc: ServiceNode, op: OpNode, guarded: boolean): PromptTask {
  const plan = buildPlan(mod);
  const planTask = plan.tasks.find((task) => task.kind === 'implement' && task.service === svc.name && task.op === op.name);
  const id = planTask?.id ?? 'impl.' + svc.name + '.' + op.name;
  const named = new Map(mod.types.map((decl) => [decl.name, decl.type]));
  const capabilityOf = new Map(svc.uses.map((use) => [use.alias, use.capability]));
  const bodyPlan = planBody(mod, svc, op);

  const input = op.params
    .map((param) => param.name + ': ' + wireType(param.type, named) + limitComment(param.type, named))
    .join(', ');
  const errors = op.clauses
    .filter((clause) => clause.kind === 'errors')
    .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));
  const resultWire = op.returns ? wireType(op.returns, named) : 'void';
  const result = errors.length
    ? '{ result: ' + resultWire + ' } | { error: ' + errors.map((name) => '"' + name + '"').join(' | ') + ' }'
    : '{ result: ' + resultWire + ' }';

  const lines = ['export async function ' + op.name + '(input, io)', 'in: { ' + input + ' }', 'out: ' + result];

  for (const clause of op.clauses) {
    // "result != null" is a tautology of the generated model: noise for the body.
    if (clause.kind === 'post' && exprText(clause.expr) === 'result != null') continue;
    if (clause.kind === 'post') lines.push('post: ' + contractText(clause.expr, svc));
    else if (clause.kind === 'pre') lines.push('pre: ' + contractText(clause.expr, svc));
    else if (clause.kind === 'onerror') lines.push('on ' + clause.error + ': ' + contractText(clause.expr, svc));
  }

  const opWord = new RegExp('\\b' + op.name + '\\b');
  const usesKv = svc.uses.some((use) => use.capability === 'kv' || use.capability.endsWith('.kv'));
  for (const rule of svc.rules) {
    if (rule.kind === 'atomic') {
      if (!opWord.test(rule.name)) continue;
      // The body must not implement get+del itself: takeIf is the atomic step.
      lines.push('atomic: ' + (usesKv ? 'takeIf(id, expected)' : rule.steps.join('; ')));
      continue;
    }
    if (rule.kind !== 'invariant') continue;
    const text = contractText(rule.expr, svc);
    if (!opWord.test(text)) continue;
    lines.push(text);
  }

  const io = opEffects(mod, svc, op, guarded)
    .map(([alias, name]) => shortFor(capabilityOf.get(alias) ?? alias, name))
    .filter((item): item is string => Boolean(item));
  if (io.length > 0) lines.push('io (all methods are async: await them): ' + io.join('; '));

  if (usesKv) {
    const stored = payloadOf(mod, op);
    const shape = stored.length === 0
      ? 'string'
      : stored.length === 1
        ? typeText(stored[0].type)
        : '{' + stored.map((param) => param.name + ': ' + typeText(param.type)).join(', ') + '}';
    lines.push(
      guarded
        ? 'record: {b: ' + shape + ', h: string|null}; h = password hash or null'
        : 'record: {b: ' + shape + ', h: null}',
    );
  }

  // The procedure is derived from the model by the planner, not written per
  // operation name: effects, rules (once/atomic) and error clauses decide it.
  if (bodyPlan.steps.length > 0) lines.push('steps: ' + planText(bodyPlan));

  const prompt = lines.join('\n') + '\n';
  return {
    id,
    op: op.name,
    file: 'impl/' + op.name + '.mjs',
    prompt,
    tokens: estimateTokens(prompt),
    sha256: createHash('sha256').update(prompt).digest('hex'),
    unresolved: bodyPlan.unresolved,
  };
}

export function formatPrompts(set: PromptSet): string {
  const lines = [
    'prompts: ' + set.tasks.length + ' (model ' + set.modelHash + ')',
    'budget: ' + set.budget + ' tokens',
  ];
  for (const task of set.tasks) {
    const mark = task.tokens > set.budget ? ' over-budget' : '';
    lines.push('  ' + task.id + '  ' + task.tokens + ' tokens  ' + task.sha256.slice(0, 12) + mark);
    for (const item of task.unresolved) lines.push('    unresolved: ' + item);
  }
  return lines.join('\n');
}
