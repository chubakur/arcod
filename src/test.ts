import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import net from 'node:net';
import type { Expr, ModuleNode, OpNode, ServiceNode, TypeExpr } from './ast.ts';
import { pickService, routeOf, statusForError } from './emit/service.ts';

export interface ExampleResult {
  example: string;
  ok: boolean;
  steps: number;
  error?: string;
}

export interface RuleResult {
  rule: string;
  ok: boolean;
  // v0.1 executes only `once(...)`. A declared predicate it cannot run is
  // reported as skipped instead of vanishing from the report: silence read as
  // "checked and passed" is the one thing a test command must never say.
  skipped?: boolean;
  detail?: string;
}

export interface TestReport {
  examples: ExampleResult[];
  rules: RuleResult[];
}

type Value = unknown;

interface Context {
  service: ServiceNode;
  ops: OpNode[];
  baseUrl: string;
  statusToError: Map<number, string>;
  // A parameter declared as a record travels as the whole object: unwrap()
  // below collapses any value carrying `id` to that id, which is right for a
  // path capture or a scalar id and wrong for a record-typed parameter.
  recordTypes: Set<string>;
}

function declaredEmbedDim(mod: ModuleNode): number | null {
  for (const env of mod.environments) {
    for (const bind of env.binds) {
      const value = bind.args.dim;
      if (value && value.kind === 'literal' && typeof value.value === 'number') return value.value;
    }
  }
  return null;
}

export async function runExamples(mod: ModuleNode, buildDir: string): Promise<TestReport> {
  const service = pickService(mod);
  if (!service || (service.examples.length === 0 && service.rules.length === 0)) {
    return { examples: [], rules: [] };
  }

  // A bind that declares dim is a promise about every vector the model
  // returns. arcod run gets that env from the provider table; a test process
  // spawns the service directly, so without it the promise was never enforced.
  const dim = declaredEmbedDim(mod);
  // Another test file's child can take the port between freePort() and the
  // listen, and the loser exits on EADDRINUSE before answering /healthz. Ask
  // the OS again and retry instead of failing an unrelated test.
  let port = 0;
  let child: ChildProcess | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3 && child === null; attempt++) {
    const candidatePort = await freePort();
    const attemptErrors: string[] = [];
    const candidate = spawn(process.execPath, [join(buildDir, 'service', 'index.mjs')], {
      env: {
        ...process.env,
        PORT: String(candidatePort),
        KV_DRIVER: 'memory',
        SQL_DRIVER: 'memory',
        AUTH_DRIVER: 'memory',
        BLOB_DRIVER: 'memory',
        LLM_DRIVER: 'memory',
        ...(dim === null ? {} : { LLM_EMBED_DIM: String(dim) }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    candidate.stderr?.on('data', (chunk) => attemptErrors.push(String(chunk)));
    try {
      await waitForHealth('http://127.0.0.1:' + candidatePort, candidate, attemptErrors);
      port = candidatePort;
      child = candidate;
    } catch (error) {
      candidate.kill('SIGKILL');
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!child) throw lastError ?? new Error('service did not start');
  const baseUrl = 'http://127.0.0.1:' + port;
  const recordTypes = new Set<string>();
  for (const decl of mod.types) if (decl.type.kind === 'record') recordTypes.add(decl.name);
  const ctx: Context = {
    service,
    ops: service.contract.filter((op) => op.kind === 'op'),
    baseUrl,
    statusToError: buildStatusMap(service),
    recordTypes,
  };

  try {
    const examples: ExampleResult[] = [];
    for (const example of service.examples) {
      try {
        const steps = await runExample(example.given, example.when, example.then, ctx);
        examples.push({ example: example.name, ok: true, steps });
      } catch (error) {
        examples.push({
          example: example.name,
          ok: false,
          steps: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const rules = await runRules(ctx);
    return { examples, rules };
  } finally {
    child.kill('SIGTERM');
  }
}

async function runRules(ctx: Context): Promise<RuleResult[]> {
  const results: RuleResult[] = [];

  for (const rule of ctx.service.rules) {
    if (rule.kind === 'invariant') {
      const predicate = asPredicate(rule.expr);
      if (predicate && predicate.name === 'once') {
        results.push(await checkOnce(rule.name, predicate.target, predicate.elseName, ctx));
      } else {
        const label = rule.expr.kind === 'call' && rule.expr.callee.kind === 'ident'
          ? rule.expr.callee.name + '(...)'
          : 'this expression';
        results.push({ rule: rule.name, ok: true, skipped: true, detail: 'predicate ' + label + ' is not executed in v0.1 (once only)' });
      }
    }

    if (rule.kind === 'atomic') {
      results.push(await checkAtomic(rule.name, ctx));
    }
  }

  return results;
}

function asPredicate(expr: Expr): { name: string; target: string; elseName: string | null } | null {
  if (expr.kind !== 'call' || expr.callee.kind !== 'ident' || expr.args.length === 0) return null;
  const target = expr.args[0].value;
  if (target.kind !== 'ident') return null;
  const elseArg = expr.args.find((arg) => arg.name === 'else');
  const elseName = elseArg && elseArg.value.kind === 'ident' ? elseArg.value.name : null;
  return { name: expr.callee.name, target: target.name, elseName };
}

async function checkOnce(rule: string, target: string, elseName: string | null, ctx: Context): Promise<RuleResult> {
  const op = ctx.ops.find((item) => item.name === target);
  if (!op) return { rule, ok: false, detail: 'operation ' + target + ' not found' };

  try {
    const id = await probeId(ctx);
    const first = await invoke(op, [id], ctx);
    const second = await invoke(op, [id], ctx);
    const secondError = errorName(second);
    const ok = errorName(first) === null && (elseName ? secondError === elseName : secondError !== null);
    return {
      rule,
      ok,
      detail: ok ? undefined : 'expected second call to fail with ' + (elseName ?? 'a declared error') + ', got ' + (secondError ?? 'success'),
    };
  } catch (error) {
    return { rule, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkAtomic(rule: string, ctx: Context): Promise<RuleResult> {
  const op = ctx.ops.find((item) => item.name === rule);
  if (!op) return { rule, ok: false, detail: 'operation ' + rule + ' not found' };

  try {
    const id = await probeId(ctx);
    const runs = await Promise.all(Array.from({ length: 10 }, () => invoke(op, [id], ctx)));
    const successes = runs.filter((value) => errorName(value) === null).length;
    return {
      rule: 'atomic ' + rule,
      ok: successes === 1,
      detail: successes === 1 ? undefined : successes + ' successful calls out of ' + runs.length + ', expected exactly 1',
    };
  } catch (error) {
    return { rule, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeId(ctx: Context): Promise<string> {
  const create = ctx.ops.find((item) => item.name === 'create');
  if (!create) throw new Error('rule check needs a create operation to prepare state');
  // Each payload parameter gets the probe; a password stays empty.
  const args = create.params.map((param) => (param.name === 'password' ? null : 'arcod rule probe'));
  const value = await invoke(create, args, ctx);
  const id = unwrap(value);
  if (typeof id !== 'string') throw new Error('create did not return an id');
  return id;
}

async function runExample(given: any[], when: any[], then: any[], ctx: Context): Promise<number> {
  const env = new Map<string, Value>();
  let steps = 0;

  // 'given' is state setup: it runs like 'when', binding lets, but its
  // results are not asserted. Both sections share the same env, so a later
  // given/when step may reference a value bound earlier.
  for (const stmt of [...given, ...when]) {
    const value = await evalExpr(stmt.expr, env, ctx);
    steps++;
    if (stmt.kind === 'let') env.set(stmt.name, value);
  }

  for (const stmt of then) {
    const value = await evalExpr(stmt.expr, env, ctx);
    steps++;
    if (stmt.kind === 'let') {
      env.set(stmt.name, value);
      continue;
    }
    if (!value) {
      throw new Error('assertion failed: ' + describe(stmt.expr) + ' (got ' + JSON.stringify(value) + ')');
    }
  }

  return steps;
}

async function evalExpr(expr: Expr, env: Map<string, Value>, ctx: Context): Promise<Value> {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'duration':
      return expr.value;

    case 'list': {
      const items: Value[] = [];
      for (const item of expr.items) items.push(await evalExpr(item, env, ctx));
      return items;
    }

    case 'record': {
      const record: Record<string, Value> = {};
      for (const field of expr.fields) record[field.name] = await evalExpr(field.value, env, ctx);
      return record;
    }

    case 'ident':
      return env.has(expr.name) ? env.get(expr.name) : expr.name;

    case 'unary': {
      const value = await evalExpr(expr.operand, env, ctx);
      return expr.op === '!' ? !value : -Number(value);
    }

    case 'binary': {
      if (expr.op === '&&') {
        return Boolean(await evalExpr(expr.left, env, ctx)) && Boolean(await evalExpr(expr.right, env, ctx));
      }
      if (expr.op === '||') {
        return Boolean(await evalExpr(expr.left, env, ctx)) || Boolean(await evalExpr(expr.right, env, ctx));
      }
      const left = await evalExpr(expr.left, env, ctx);
      const right = await evalExpr(expr.right, env, ctx);
      switch (expr.op) {
        case '==': return equals(left, right);
        case '!=': return !equals(left, right);
        case '<': return Number(left) < Number(right);
        case '<=': return Number(left) <= Number(right);
        case '>': return Number(left) > Number(right);
        case '>=': return Number(left) >= Number(right);
        case '+': return typeof left === 'number' && typeof right === 'number' ? left + right : String(left) + String(right);
        case '-': return Number(left) - Number(right);
        case '*': return Number(left) * Number(right);
        case '/': return Number(left) / Number(right);
        case '%': return Number(left) % Number(right);
        default: throw new Error('unsupported operator ' + expr.op);
      }
    }

    case 'is': {
      const value = await evalExpr(expr.expr, env, ctx);
      return isErrorValue(value, expr.error);
    }

    case 'call': {
      // `hits[0]` is a call whose callee is a member named `[]`. Only the
      // index form is allowed here; any other method call stays unsupported.
      if (expr.callee.kind === 'member' && expr.callee.property === '[]') {
        const base = await evalExpr(expr.callee.object, env, ctx);
        const failed = errorName(base);
        if (failed) throw new Error('[] read from an error value: ' + failed);
        if (!Array.isArray(base)) {
          throw new Error('index on a non-list: ' + describe(expr.callee.object));
        }
        const raw = expr.args.length > 0 ? await evalExpr(expr.args[0].value, env, ctx) : null;
        const index = Number(raw);
        if (!Number.isInteger(index)) {
          throw new Error('index is not an integer: ' + describe(expr.callee.object) + '[' + JSON.stringify(raw) + ']');
        }
        if (index < 0 || index >= base.length) {
          throw new Error('index ' + index + ' out of range (len ' + base.length + ') in ' + describe(expr.callee.object));
        }
        return base[index] as Value;
      }
      if (expr.callee.kind !== 'ident') throw new Error('unsupported call expression');
      const name = expr.callee.name;
      const args: Value[] = [];
      for (const arg of expr.args) args.push(await evalExpr(arg.value, env, ctx));

      const op = ctx.ops.find((item) => item.name === name);
      if (op) return invoke(op, args, ctx);
      if (name === 'uuid') return args[0] ?? '';
      throw new Error('unknown function ' + name + ' in example');
    }

    case 'member': {
      const base = await evalExpr(expr.object, env, ctx);
      const failed = errorName(base);
      if (failed) throw new Error('.' + expr.property + ' read from an error value: ' + failed);
      if (!base || typeof base !== 'object') return null;
      const record = base as Record<string, unknown>;
      return expr.property in record ? (record[expr.property] as Value) : null;
    }

    default:
      throw new Error('unsupported expression');
  }
}

async function invoke(op: OpNode, args: Value[], ctx: Context): Promise<Value> {
  const route = routeOf(op);
  if (!route) throw new Error('op ' + op.name + ' has no route');
  const space = route.indexOf(' ');
  // Route clauses may be written in any case (A070), the wire wants upper.
  const method = route.slice(0, space).toUpperCase();
  // HEAD is a GET without a response body: query, no body. Only these three
  // methods keep their parameters out of the payload.
  const bodyless = method === 'GET' || method === 'DELETE' || method === 'HEAD';
  let path = route.slice(space + 1);

  const pathParams = Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1]);
  // Values are matched by name, not by position: filtering an earlier capture
  // out of `args` shifted every later index, so a second capture took the
  // first body value and the body took the ones after it.
  const byName = new Map<string, Value>();
  op.params.forEach((param, index) => byName.set(param.name, args[index]));
  for (const name of pathParams) {
    if (!byName.has(name)) throw new Error('no parameter ' + name + ' in ' + op.name);
    path = path.replace(':' + name, () => encodeURIComponent(String(unwrap(byName.get(name)))));
  }

  if (bodyless) {
    const query = new URLSearchParams();
    const remaining = op.params.filter((param) => !pathParams.includes(param.name));
    remaining.forEach((param) => {
      const value = unwrap(byName.get(param.name));
      if (value !== null && value !== undefined && value !== '') query.set(param.name, String(value));
    });
    if (query.size > 0) path += '?' + query.toString();
  }

  let body: string | undefined;
  if (!bodyless) {
    const payload: Record<string, unknown> = {};
    const remaining = op.params.filter((param) => !pathParams.includes(param.name));
    remaining.forEach((param) => {
      payload[param.name] = isRecordType(param.type, ctx.recordTypes)
        ? byName.get(param.name)
        : unwrap(byName.get(param.name));
    });
    body = JSON.stringify(payload);
  }

  const response = await fetch(ctx.baseUrl + path, {
    method,
    // Examples run against the memory identity driver: authenticate as a
    // fixed actor so `auth op`s are exercisable (a missing actor is already
    // covered by the static checks and the on-error clauses).
    headers: { 'x-actor': 'u-andrey', ...(body ? { 'content-type': 'application/json' } : {}) },
    body,
  });

  if (response.ok) {
    // A HEAD answer has no body at all; JSON.parse('') would fail the example.
    const raw = await response.text();
    if (raw === '') return null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  // 501 is the scaffold's "this op has no body", not a declared error: name
  // the missing body and the command that fills it instead of HTTP_501, which
  // told a reader nothing about impl/<op>.mjs.
  if (response.status === 501) {
    let todo = '';
    try {
      const payload = JSON.parse(await response.text()) as { todo?: unknown };
      if (typeof payload.todo === 'string') todo = ' (' + payload.todo + ')';
    } catch {
      // A non-JSON 501 still gets the sentence below.
    }
    throw new Error('op ' + op.name + ' has no implementation: the service answers 501' + todo +
      '; run "arcod impl" or add impl/' + op.name + '.mjs');
  }

  const name = ctx.statusToError.get(response.status) ?? 'HTTP_' + response.status;
  return { __error: name };
}

function isErrorValue(value: Value, name: string): boolean {
  return Boolean(value) && typeof value === 'object' && (value as { __error?: string }).__error === name;
}

function equals(left: Value, right: Value): boolean {
  const leftError = errorName(left);
  const rightError = errorName(right);
  if (leftError || rightError) return leftError !== null && leftError === rightError;
  return left === right;
}

function errorName(value: Value): string | null {
  if (!value || typeof value !== 'object') return null;
  const name = (value as { __error?: unknown }).__error;
  return typeof name === 'string' ? name : null;
}

function isRecordType(type: TypeExpr | null, recordTypes: Set<string>): boolean {
  if (!type) return false;
  if (type.kind === 'record') return true;
  return type.kind === 'named' && recordTypes.has(type.name);
}

function unwrap(value: Value): unknown {
  if (value && typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    return (value as { id: unknown }).id;
  }
  return value;
}

function describe(expr: Expr): string {
  if (expr.kind === 'call' && expr.callee.kind === 'ident') return expr.callee.name + '(...)';
  if (expr.kind === 'call' && expr.callee.kind === 'member' && expr.callee.property === '[]') return describe(expr.callee.object) + '[...]';
  if (expr.kind === 'member') return describe(expr.object) + '.' + expr.property;
  if (expr.kind === 'is') return describe(expr.expr) + ' is ' + expr.error;
  if (expr.kind === 'binary') return describe(expr.left) + ' ' + expr.op + ' ' + describe(expr.right);
  if (expr.kind === 'ident') return expr.name;
  if (expr.kind === 'literal') return JSON.stringify(expr.value);
  return 'expression';
}

function buildStatusMap(service: ServiceNode): Map<number, string> {
  const map = new Map<number, string>();
  for (const op of service.contract) {
    for (const clause of op.clauses) {
      if (clause.kind !== 'errors') continue;
      for (const name of clause.names) map.set(statusForError(name), name);
    }
  }
  return map;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
  const address = server.address() as { port: number };
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(baseUrl: string, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('service exited before start: ' + stderr.join('').trim());
    }
    if (stderr.join('').includes('EADDRINUSE')) {
      throw new Error('port already in use: ' + stderr.join('').trim().slice(-500));
    }
    try {
      const response = await fetch(baseUrl + '/healthz');
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('service did not become healthy in 5s: ' + stderr.join('').trim());
}
