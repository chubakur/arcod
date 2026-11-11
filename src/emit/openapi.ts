// OpenAPI 3.1 emitter. The HTTP runtime is ad-hoc routes; this is the stable
// external contract: paths from `route`, schemas from `types`, error mapping
// shared with the runtime, examples from the `examples` block. Providers and
// hosts never appear here — the spec does not name them, so neither do we.

import type {
  ExampleNode,
  Expr,
  ModuleNode,
  OpNode,
  Param,
  ServiceNode,
  TypeArg,
  TypeExpr,
} from '../ast.ts';
import { pickService, routeOf, statusForError } from './service.ts';

export interface OpenapiOptions {
  // Only this service's operations are exported; defaults to the local one.
  // External services are contracts too, so `emitOpenapi` can target them.
  service?: string;
}

// The document is plain JSON; typing it strictly would buy nothing here.
export type OpenapiDocument = Record<string, unknown>;

type Schema = Record<string, unknown>;

const BUILTINS = new Set([
  'string',
  'bytes',
  'int',
  'float',
  'number',
  'bool',
  'boolean',
  'uuid',
  'json',
  'list',
  'map',
  'void',
  'null',
]);

function sizeBytes(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === 'kb') return value * 1024;
  if (normalized === 'mb') return value * 1024 * 1024;
  if (normalized === 'gb') return value * 1024 * 1024 * 1024;
  return value;
}

function numberArg(args: TypeArg[], name: string): number | null {
  for (const arg of args) {
    if (arg.name !== name) continue;
    const value = arg.value;
    if (value.kind === 'literal' && typeof value.value === 'number') return value.value;
    if (value.kind === 'duration') return sizeBytes(value.value, value.unit);
  }
  return null;
}

function resolveDecl(mod: ModuleNode, type: TypeExpr): TypeExpr {
  let current = type;
  for (let depth = 0; depth < 8; depth++) {
    if (current.kind !== 'named') return current;
    const decl = mod.types.find((item) => item.name === current.name);
    if (!decl) return current;
    current = decl.type;
  }
  return current;
}

function builtinSchema(name: string, args: TypeArg[]): Schema {
  if (name === 'string' || name === 'bytes') {
    const schema: Schema = { type: 'string' };
    const min = numberArg(args, 'min');
    const max = numberArg(args, 'max');
    if (min !== null) schema.minLength = min;
    if (max !== null) schema.maxLength = max;
    return schema;
  }
  if (name === 'int') return { type: 'integer' };
  if (name === 'float' || name === 'number') return { type: 'number' };
  if (name === 'bool' || name === 'boolean') return { type: 'boolean' };
  if (name === 'uuid') return { type: 'string', format: 'uuid' };
  if (name === 'json') return {};
  if (name === 'void' || name === 'null') return { type: 'null' };
  if (name === 'list') {
    const item = args.find((arg) => arg.isType);
    return { type: 'array', items: item && item.isType ? schemaFor(null, item.value as TypeExpr) : {} };
  }
  if (name === 'map') {
    const value = args[1];
    return { type: 'object', additionalProperties: value && value.isType ? schemaFor(null, value.value as TypeExpr) : true };
  }
  return {};
}

function objectSchema(mod: ModuleNode | null, fields: Param[]): Schema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    const optional = field.type.kind === 'optional' || field.default !== undefined;
    properties[field.name] = schemaFor(mod, field.type);
    if (!optional) required.push(field.name);
  }
  const schema: Schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

// Nominal types are named components: `type MessageId = uuid` becomes a
// reusable MessageId schema and every use is a $ref to it — that is what
// keeps the contract stable. Component bodies are built with mod = null so a
// recursive type (type A = { next: A }) expands through $ref instead of
// recursing forever.
function schemaFor(mod: ModuleNode | null, type: TypeExpr): Schema {
  if (type.kind === 'optional') {
    return { anyOf: [schemaFor(mod, type.inner), { type: 'null' }] };
  }
  if (type.kind === 'union') {
    return { anyOf: type.variants.map((variant) => schemaFor(mod, variant)) };
  }
  if (type.kind === 'record') {
    return objectSchema(mod, type.fields);
  }
  if (!BUILTINS.has(type.name)) {
    return { $ref: '#/components/schemas/' + type.name };
  }
  if (type.args.length === 0 || !mod) {
    return builtinSchema(type.name, type.args);
  }
  // A builtin with arguments (bytes(min, max)) is a refinement, not a new
  // name. If a user type shares the name it wins, as everywhere else.
  const decl = mod.types.find((item) => item.name === type.name);
  if (!decl) return builtinSchema(type.name, type.args);
  const resolved = resolveDecl(mod, decl.type);
  if (resolved.kind === 'named' && BUILTINS.has(resolved.name)) {
    return { ...builtinSchema(resolved.name, resolved.args), ...builtinSchema(type.name, type.args) };
  }
  return schemaFor(mod, decl.type);
}

function errorSchema(mod: ModuleNode | null, name: string): Schema {
  const known = mod?.errors.find((err) => err.name === name);
  if (!known) {
    return {
      type: 'object',
      properties: { error: { type: 'string', const: name }, message: { type: 'string' } },
      required: ['error', 'message'],
    };
  }
  const properties: Record<string, unknown> = {
    error: { type: 'string', const: known.name },
    message: { type: 'string' },
  };
  for (const field of known.fields) properties[field.name] = schemaFor(mod, field.type);
  return { type: 'object', properties, required: ['error', 'message'] };
}

function components(mod: ModuleNode): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const decl of mod.types) {
    schemas[decl.name] = schemaFor(null, decl.type);
  }
  for (const en of mod.enums) {
    schemas[en.name] = { type: 'string', enum: en.values };
  }
  for (const err of mod.errors) {
    schemas['Error' + err.name] = errorSchema(null, err.name);
  }
  return schemas;
}

interface RouteInfo {
  method: string;
  path: string;
}

function routeInfo(op: OpNode): RouteInfo {
  const value = routeOf(op) ?? op.name;
  const [method, path] = value.split(/\s+/);
  return { method: (method || 'GET').toUpperCase(), path: toOpenapiPath(path || '/') };
}

function toOpenapiPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '{' + segment.slice(1) + '}' : segment))
    .join('/');
}

function paramLocation(route: RouteInfo, param: Param): 'path' | 'query' | 'body' {
  const inPath = route.path.split('/').some((segment) => segment === '{' + param.name + '}');
  if (inPath) return 'path';
  return route.method === 'GET' || route.method === 'DELETE' ? 'query' : 'body';
}

function errorNamesOf(op: OpNode): string[] {
  const clause = op.clauses.find((c) => c.kind === 'errors');
  return clause && clause.kind === 'errors' ? clause.names : [];
}

function literalValue(expr: Expr): unknown {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'duration') return expr.value + expr.unit;
  return undefined;
}

// One pass over the examples block. `when { let id = create("hi") }` becomes
// an example on create; bindings are kept so `then { e is Invalid }` can
// attach an error example to the operation that produced `e`.
interface ExampleCall {
  target: string;
  example: string;
  value: Record<string, unknown>;
}

interface ExampleError {
  target: string;
  example: string;
  error: string;
}

function interpretExamples(svc: ServiceNode): { calls: ExampleCall[]; errors: ExampleError[] } {
  const calls: ExampleCall[] = [];
  const errors: ExampleError[] = [];

  for (const example of svc.examples) {
    const bound = new Map<string, string>();

    for (const stmt of example.when) {
      const expr = stmt.expr;
      if (expr.kind !== 'call' || expr.callee.kind !== 'ident') continue;
      const target = svc.contract.find((item) => item.name === expr.callee.name && item.kind === 'op');
      if (!target) continue;
      if (stmt.kind === 'let') bound.set(stmt.name, target.name);

      const value: Record<string, unknown> = {};
      let complete = true;
      expr.args.forEach((arg, index) => {
        const converted = literalValue(arg.value);
        if (converted === undefined) {
          complete = false;
          return;
        }
        const name = arg.name ?? target.params[index]?.name ?? 'arg' + index;
        value[name] = converted;
      });
      if (complete) calls.push({ target: target.name, example: example.name, value });
    }

    for (const stmt of example.then) {
      if (stmt.kind !== 'expr' || stmt.expr.kind !== 'is') continue;
      const is = stmt.expr;
      const producer = is.expr.kind === 'ident'
        ? bound.get(is.expr.name)
        : is.expr.kind === 'call' && is.expr.callee.kind === 'ident' ? is.expr.callee.name : null;
      if (producer) errors.push({ target: producer, example: example.name, error: is.error });
    }
  }

  return { calls, errors };
}

function operationFor(mod: ModuleNode, svc: ServiceNode, op: OpNode): Record<string, unknown> {
  const route = routeInfo(op);

  const responses: Record<string, unknown> = {};
  const successStatus = route.method === 'GET' || route.method === 'DELETE' ? '200' : '201';
  const success: Record<string, unknown> = { description: 'ok' };
  if (op.returns && !(op.returns.kind === 'named' && (op.returns.name === 'void' || op.returns.name === 'null'))) {
    const schema = schemaFor(mod, op.returns);
    const isString = schema.type === 'string' && schema.$ref === undefined;
    success.content = isString
      ? { 'text/plain': { schema } }
      : { 'application/json': { schema } };
  }
  responses[successStatus] = success;

  for (const name of errorNamesOf(op)) {
    const status = statusForError(name);
    const body = errorSchema(mod, name);
    const existing = responses[String(status)] as Record<string, unknown> | undefined;
    if (existing && existing.description === 'ok') continue; // success owns its status
    if (existing) {
      // Two declared errors map to one status (Forbidden/WrongPassword):
      // oneOf keeps both shapes in the contract.
      const prev = (existing.content as Record<string, { schema: unknown }>)['application/json'].schema;
      existing.content = { 'application/json': { schema: { oneOf: [prev, body] } } };
      existing.description = String(existing.description) + ', ' + name;
    } else {
      responses[String(status)] = { description: name, content: { 'application/json': { schema: body } } };
    }
  }

  const parameters: Array<Record<string, unknown>> = [];
  let requestBody: Record<string, unknown> | null = null;
  for (const param of op.params) {
    const where = paramLocation(route, param);
    const schema = schemaFor(mod, param.type);
    const optional = param.type.kind === 'optional' || param.default !== undefined;
    if (where === 'body') {
      requestBody ??= {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: {} as Record<string, unknown> } } },
      };
      const bodySchema = (requestBody.content as Record<string, Record<string, unknown>>)['application/json'].schema as Record<string, unknown>;
      (bodySchema.properties as Record<string, unknown>)[param.name] = schema;
      if (!optional) ((bodySchema.required ??= []) as string[]).push(param.name);
    } else {
      parameters.push({
        name: param.name,
        in: where,
        required: where === 'path' ? true : !optional,
        schema,
      });
    }
  }

  const operation: Record<string, unknown> = {
    operationId: svc.name + '.' + op.name,
    tags: [svc.name],
    responses,
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

export function emitOpenapi(mod: ModuleNode, options: OpenapiOptions = {}): OpenapiDocument {
  const svc = options.service
    ? mod.services.find((item) => item.name === options.service)
    : pickService(mod);
  if (!svc) throw new Error('no service to emit OpenAPI for');

  const examples = interpretExamples(svc);
  const paths: Record<string, unknown> = {};

  for (const op of svc.contract) {
    if (op.kind !== 'op' || !routeOf(op)) continue; // A050 covers the no-route case
    if (!svc.external && !op.isPublic && !op.auth) continue; // auth ops are public surface too // an external contract is entirely public surface
    const { method, path } = routeInfo(op);
    const operation = operationFor(mod, svc, op);

    const opExamples: Record<string, unknown> = {};
    for (const call of examples.calls) {
      if (call.target === op.name) opExamples[call.example] = { value: call.value };
    }
    if (Object.keys(opExamples).length > 0) operation.examples = opExamples;
    const responses = operation.responses as Record<string, unknown>;
    for (const entry of examples.errors) {
      if (entry.target !== op.name) continue;
      const status = String(statusForError(entry.error));
      const response = responses[status] as Record<string, unknown> | undefined;
      if (!response) continue;
      const content = (response.content ??= {}) as Record<string, unknown>;
      (content['application/json'] ??= {}) as Record<string, unknown>;
      const media = content['application/json'] as Record<string, unknown>;
      (media.examples ??= {}) as Record<string, unknown>;
      ((media.examples as Record<string, unknown>)[entry.example] = { value: { error: entry.error } });
    }

    const pathItem = (paths[path] ??= {}) as Record<string, unknown>;
    pathItem[method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: mod.name,
      version: mod.version,
    },
    paths,
    components: { schemas: components(mod) },
  };
}
