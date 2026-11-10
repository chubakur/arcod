import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import net from 'node:net';
import type { Expr, ModuleNode, OpNode, ServiceNode } from './ast.ts';
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
}

export async function runExamples(mod: ModuleNode, buildDir: string): Promise<TestReport> {
  const service = pickService(mod);
  if (!service || (service.examples.length === 0 && service.rules.length === 0)) {
    return { examples: [], rules: [] };
  }

  const port = await freePort();
  const child = spawn(process.execPath, [join(buildDir, 'service', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), KV_DRIVER: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const baseUrl = 'http://127.0.0.1:' + port;
  const ctx: Context = {
    service,
    ops: service.contract.filter((op) => op.kind === 'op'),
    baseUrl,
    statusToError: buildStatusMap(service),
  };

  try {
    await waitForHealth(baseUrl, child, stderr);
    const examples: ExampleResult[] = [];
    for (const example of service.examples) {
      try {
        const steps = await runExample(example.when, example.then, ctx);
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
  const value = await invoke(create, ['arcod rule probe'], ctx);
  const id = unwrap(value);
  if (typeof id !== 'string') throw new Error('create did not return an id');
  return id;
}

async function runExample(when: any[], then: any[], ctx: Context): Promise<number> {
  const env = new Map<string, Value>();
  let steps = 0;

  for (const stmt of when) {
    const value = await evalExpr(stmt.expr, env, ctx);
    steps++;
    if (stmt.kind === 'let') env.set(stmt.name, value);
  }

  for (const stmt of then) {
    const value = await evalExpr(stmt.expr, env, ctx);
    steps++;
    if (!value) {
      throw new Error('assertion failed: ' + describe(stmt.expr));
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
      if (expr.callee.kind !== 'ident') throw new Error('unsupported call expression');
      const name = expr.callee.name;
      const args: Value[] = [];
      for (const arg of expr.args) args.push(await evalExpr(arg.value, env, ctx));

      const op = ctx.ops.find((item) => item.name === name);
      if (op) return invoke(op, args, ctx);
      if (name === 'uuid') return args[0] ?? '';
      throw new Error('unknown function ' + name + ' in example');
    }

    case 'member':
      throw new Error('member access is not supported in examples');

    default:
      throw new Error('unsupported expression');
  }
}

async function invoke(op: OpNode, args: Value[], ctx: Context): Promise<Value> {
  const route = routeOf(op);
  if (!route) throw new Error('op ' + op.name + ' has no route');
  const space = route.indexOf(' ');
  const method = route.slice(0, space);
  let path = route.slice(space + 1);

  const pathParams = Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1]);
  for (const name of pathParams) {
    const index = op.params.findIndex((param) => param.name === name);
    if (index < 0) throw new Error('no parameter ' + name + ' in ' + op.name);
    path = path.replace(':' + name, encodeURIComponent(String(unwrap(args[index]))));
    args = args.filter((_, i) => i !== index);
  }

  if (method === 'GET' || method === 'DELETE') {
    const query = new URLSearchParams();
    const remaining = op.params.filter((param) => !pathParams.includes(param.name));
    remaining.forEach((param, index) => {
      const value = unwrap(args[index]);
      if (value !== null && value !== undefined && value !== '') query.set(param.name, String(value));
    });
    if (query.size > 0) path += '?' + query.toString();
  }

  let body: string | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    const payload: Record<string, unknown> = {};
    const remaining = op.params.filter((param) => !pathParams.includes(param.name));
    remaining.forEach((param, index) => {
      payload[param.name] = unwrap(args[index]);
    });
    body = JSON.stringify(payload);
  }

  const response = await fetch(ctx.baseUrl + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body,
  });

  if (response.ok) {
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) return await response.json();
    return await response.text();
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

function unwrap(value: Value): unknown {
  if (value && typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    return (value as { id: unknown }).id;
  }
  return value;
}

function describe(expr: Expr): string {
  if (expr.kind === 'call' && expr.callee.kind === 'ident') return expr.callee.name + '(...)';
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
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
