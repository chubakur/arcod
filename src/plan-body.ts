import type { Expr, ModuleNode, OpNode, Param, ServiceNode } from './ast.ts';
import { asOnce } from './check.ts';
import { storageUse } from './capabilities.ts';

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
  // Declared effects win: the model says exactly what the body touches.
  const declared = op.clauses
    .filter((clause) => clause.kind === 'effects')
    .flatMap((clause) => (clause.kind === 'effects' ? clause.names : []));
  if (declared.length > 0) {
    return declared.map((entry) => {
      const [alias, name] = entry.split('.');
      return [alias, name] as [string, string];
    });
  }

  const out: Array<[string, string]> = [];
  const add = (alias: string, name: string) => {
    if (out.some(([a, o]) => a === alias && o === name)) return;
    out.push([alias, name]);
  };

  const kv = storageUse(svc)?.alias;
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

// Parameters that make up the stored payload: everything except the id and the
// password. Order follows the signature, so the same model gives the same body.
export function payloadOf(mod: ModuleNode, op: OpNode): Param[] {
  const password = op.params.find((param) => param.name === 'password' || rawName(param.type) === 'Password');
  return op.params.filter(
    (param) => param !== password && resolveType(mod, param.type) !== 'uuid',
  );
}

export function planBody(mod: ModuleNode, svc: ServiceNode, op: OpNode): BodyPlan {
  const guarded = svc.uses.some((use) => use.capability === 'hash' || use.capability.endsWith('.hash'));
  const effects = opEffects(mod, svc, op, guarded);
  const names = new Set(effects.map(([, name]) => name));
  const errors = op.clauses
    .filter((clause) => clause.kind === 'errors')
    .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []));

  const once = svc.rules
    .map((rule) => (rule.kind === 'invariant' ? asOnce(rule.expr) : null))
    .find((item) => item && item.op === op.name) ?? null;
  const onceError = once && once.elseName ? once.elseName : null;

  const kindOf = (alias: string): string => {
    const use = svc.uses.find((item) => item.alias === alias);
    if (!use) return '';
    return use.capability.startsWith('arcod.std.') ? use.capability.slice('arcod.std.'.length) : use.capability;
  };
  const has = (kind: string, name: string) => effects.some(([alias, op]) => op === name && kindOf(alias) === kind);
  const storageGet = has('kv', 'get') || has('sql', 'get');
  const storageSet = has('kv', 'set') || has('sql', 'set');
  const storageScan = has('kv', 'scan') || has('sql', 'scan');
  const blobGet = has('blob', 'get');
  const blobPut = has('blob', 'put');

  const password = op.params.find((param) => param.name === 'password' || rawName(param.type) === 'Password');
  const idParam = op.params.find((param) => resolveType(mod, param.type) === 'uuid');
  const payloadParams = payloadOf(mod, op);
  // Several parameters can be bytes (a name and its content). Prefer the ones
  // conventionally holding the object itself, then the last bytes parameter.
  const BYTES_NAMES = ['body', 'content', 'contents', 'data', 'file', 'payload', 'value', 'bytes'];
  const bytesParams = op.params.filter((param) => resolveType(mod, param.type) === 'bytes');
  const bytesParam = bytesParams.find((param) => BYTES_NAMES.includes(param.name))
    ?? bytesParams[bytesParams.length - 1];
  const returns = op.returns ? resolveType(mod, op.returns) : null;
  const listReturn = Boolean(op.returns && op.returns.kind === 'named' && op.returns.name === 'list');

  const intents: string[] = [];
  const steps: string[] = [];
  const unresolved: string[] = [];

  const quote = (value: string) => "'" + value + "'";
  const errorFor = (skip: string[]) => errors.find((name) => !skip.includes(name)) ?? null;

  if (names.has('actor')) {
    intents.push('actor');
    steps.push('actor = await io.actor()');
    if (errors.includes('Unauthorized')) steps.push("if (!actor) return { error: 'Unauthorized' }");
  }

  if (names.has('users')) {
    intents.push('directory');
    steps.push('users = await io.users()');
  }

  if (names.has('new')) {
    intents.push('generate-id');
    steps.push('id = await io.new()');
  }

  if (storageGet && idParam) {
    intents.push('load');
    steps.push('rec = await io.load(' + idParam.name + ')');
    if (storageSet) {
      const missing = errorFor(['Unauthorized', 'Forbidden', 'Gone']) ?? 'NotFound';
      steps.push("if (!rec) return { error: " + quote(missing) + " }");
    } else {
      const missing = errorFor(['Unauthorized', 'Forbidden']) ?? 'NotFound';
      steps.push(onceError && onceError !== missing
        ? "if (!rec) return (await io.seen(" + idParam.name + ")) ? { error: " + quote(onceError) + " } : { error: " + quote(missing) + " }"
        : "if (!rec) return { error: " + quote(missing) + " }");
    }
  }

  if (names.has('verify') && password) {
    const verifyError = errorFor(['Unauthorized', 'Forbidden', 'NotFound', 'Gone', onceError ?? '']);
    if (verifyError) {
      intents.push('verify');
      steps.push('if (!rec.h || !(await io.verify(' + password.name + ', rec.h))) return { error: ' + quote(verifyError) + ' }');
    }
  }

  if (names.has('takeIf') && idParam) {
    const failure = onceError ?? (errors.includes('Gone') ? 'Gone' : null);
    if (!failure) {
      unresolved.push('consume is required but the operation declares no error for an already consumed value');
    } else {
      intents.push('consume');
      steps.push('if (!(await io.takeIf(' + idParam.name + ', rec))) return { error: ' + quote(failure) + ' }');
    }
  }

  if (blobGet) {
    intents.push('read-object');
    steps.push('body = await io.blobGet(' + (idParam ? idParam.name : 'id') + ')');
  }

  if (storageSet) {
    intents.push('persist');
    const fields = payloadParams.map((param) => param.name + ': ' + param.name).join(', ');
    const hash = guarded && password
      ? password.name + ' ? await io.hash(' + password.name + ') : null'
      : 'null';
    if (names.has('new') || !idParam) {
      steps.push('await io.save(id, { b: { ' + fields + ' }, h: ' + hash + ' })');
    } else {
      steps.push('rec.b = { ...rec.b, ' + fields + ' }');
      steps.push('await io.save(' + idParam.name + ', { b: rec.b, h: rec.h })');
    }
  }

  if (blobPut) {
    intents.push('write-object');
    steps.push('await io.blobPut(' + (names.has('new') || !idParam ? 'id' : idParam.name) + ', '
      + (bytesParam ? bytesParam.name : 'value') + ')');
  }

  if (storageScan) {
    intents.push('scan');
    steps.push('items = await io.scan()');
  }

  if (names.has('del') && idParam) {
    intents.push('remove');
    steps.push('await io.del(' + idParam.name + ')');
  }

  // The return shape decides the result: no operation name is involved.
  if (returns === 'uuid') steps.push('return { result: id }');
  else if (returns === 'bool') steps.push('return { result: true }');
  else if (returns === 'bytes') steps.push('return { result: body }');
  else if (returns === 'string') steps.push('return { result: body || rec }');
  else if (listReturn) steps.push('return { result: ' + (names.has('users') ? 'users' : 'items') + ' }');
  else if (op.returns && op.returns.kind === 'record') {
    const fields = op.returns.fields.map((field) => {
      const fromParam = op.params.some((param) => param.name === field.name);
      const value = field.name === 'body' && blobGet
        ? 'body'
        : fromParam
          ? field.name
          : 'rec.b.' + field.name;
      return field.name + ': ' + value;
    });
    steps.push('return { result: { ' + fields.join(', ') + ' } }');
  } else if (returns) {
    steps.push('return { result: ... }');
  }

  return { intents, steps, unresolved };
}

export function planText(plan: BodyPlan): string {
  return plan.steps.length > 0 ? plan.steps.join('; ') : '(no procedure derived)';
}
