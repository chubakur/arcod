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
import { accessNotes, pickService, routeOf, statusForError } from './service.ts';
import { parseRoute, successStatus as contractSuccessStatus } from './contract.ts';
import { baseType } from '../migrate.ts';
import { canonicalInstant } from '../instant.ts';

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
  'datetime',
  'decimal',
  'list',
  'map',
  'void',
  'null',
  'email',
  'url',
  'uri',
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

function formatArg(args: TypeArg[]): string | null {
  for (const arg of args) {
    if (arg.name !== 'format') continue;
    const value = arg.value;
    if (value.kind === 'ident') return value.name;
    if (value.kind === 'literal' && typeof value.value === 'string') return value.value;
  }
  return null;
}

function builtinSchema(name: string, args: TypeArg[]): Schema {
  // `email` and `url` are shorthands; `string(format: email)` is the same fact.
  if (name === 'email') return { type: 'string', format: 'email' };
  if (name === 'url' || name === 'uri') return { type: 'string', format: 'uri' };
  if (name === 'string' || name === 'bytes') {
    const schema: Schema = { type: 'string' };
    const min = numberArg(args, 'min');
    const max = numberArg(args, 'max');
    if (min !== null) schema.minLength = min;
    if (max !== null) schema.maxLength = max;
    if (name === 'string') {
      const format = formatArg(args);
      if (format === 'email') schema.format = 'email';
      if (format === 'url' || format === 'uri') schema.format = 'uri';
    }
    return schema;
  }
  if (name === 'int') {
    const schema: Schema = { type: 'integer' };
    const min = numberArg(args, 'min');
    const max = numberArg(args, 'max');
    if (min !== null) schema.minimum = min;
    if (max !== null) schema.maximum = max;
    return schema;
  }
  if (name === 'float' || name === 'number') {
    // A real bound is a bound on reals: `number(min: 0.5)` means 0.5, not the
    // nearest integer the way an integer bound has to be rounded.
    const schema: Schema = { type: 'number' };
    const min = numberArg(args, 'min');
    const max = numberArg(args, 'max');
    if (min !== null) schema.minimum = min;
    if (max !== null) schema.maximum = max;
    return schema;
  }
  if (name === 'bool' || name === 'boolean') return { type: 'boolean' };
  if (name === 'uuid') return { type: 'string', format: 'uuid' };
  if (name === 'datetime') return { type: 'string', format: 'date-time' };
  if (name === 'decimal') {
    const schema: Schema = { type: 'number', format: 'decimal' };
    const min = numberArg(args, 'min');
    const max = numberArg(args, 'max');
    if (min !== null) schema.minimum = min;
    if (max !== null) schema.maximum = max;
    return schema;
  }
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

// A declared default is a contract fact, not only a runtime convenience: the
// client sees the same value the server would insert. Only literals reach
// here; check() rejects anything else (A059).
function literalOf(expr: Expr | undefined): unknown {
  return expr && expr.kind === 'literal' ? expr.value : undefined;
}

// A datetime default reaches the client in the spelling a store keeps, not the
// one the spec wrote: `2026-01-01T02:00:00+02:00` is published as
// `2026-01-01T00:00:00Z`, which is exactly what the row reads back. Publishing
// the literal would advertise a client-side default that the server never
// returns.
function withDefault(schema: Schema, field: Param, mod: ModuleNode | null): Schema {
  const value = literalOf(field.default);
  if (value === undefined) return schema;
  if (typeof value === 'string' && mod && baseType(mod, field.type) === 'datetime') {
    return { ...schema, default: canonicalInstant(value) ?? value };
  }
  return { ...schema, default: value };
}

// A model name may be __proto__; assigning it through an index would set the
// prototype of the schema map, and the field would vanish from the published
// contract while the runtime still accepts and requires it. Define an own,
// enumerable property instead.
function putKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function objectSchema(mod: ModuleNode | null, fields: Param[]): Schema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    const optional = field.type.kind === 'optional' || field.default !== undefined;
    putKey(properties, field.name, withDefault(schemaFor(mod, field.type), field, mod));
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
  // A builtin with arguments (bytes(min, max)) is a refinement, not a new
  // name. A declaration can no longer share a builtin name (A089), so the
  // arguments always refine the builtin itself.
  return builtinSchema(type.name, type.args);
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
  for (const field of known.fields) putKey(properties, field.name, schemaFor(mod, field.type));
  return { type: 'object', properties, required: ['error', 'message'] };
}

function components(mod: ModuleNode): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const decl of mod.types) {
    // A record resolves its names to $refs either way; the module is needed
    // only so a datetime default is published in its stored spelling.
    putKey(schemas, decl.name, schemaFor(mod, decl.type));
  }
  for (const en of mod.enums) {
    putKey(schemas, en.name, { type: 'string', enum: en.values });
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
  // The same parse the runtime uses (contract IR): a method written lowercase
  // is published in the casing the server matches.
  const route = parseRoute(op);
  if (!route) return { method: 'GET', path: toOpenapiPath('/' + op.name) };
  return { method: route.method, path: toOpenapiPath(route.path) };
}

// The router drops empty segments when it matches (check A069 does the same),
// so `/v1//x/` and `/v1/x` are one route. The document lists the canonical
// spelling, or a client would call a path the server only reaches by accident.
function toOpenapiPath(path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? '{' + segment.slice(1) + '}' : segment));
  return '/' + segments.join('/');
}

function paramLocation(route: RouteInfo, param: Param): 'path' | 'query' | 'body' {
  const inPath = route.path.split('/').some((segment) => segment === '{' + param.name + '}');
  if (inPath) return 'path';
  // HEAD is body-less like GET: what the runtime sends in the query string
  // must be documented as a query parameter, not as a requestBody.
  return route.method === 'GET' || route.method === 'DELETE' || route.method === 'HEAD' ? 'query' : 'body';
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
      if (expr.kind !== 'call') continue;
      const callee = expr.callee;
      if (callee.kind !== 'ident') continue;
      const target = svc.contract.find((item) => item.name === callee.name && item.kind === 'op');
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
        putKey(value, name, converted);
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
  // Published from the same rule the runtime answers with (contract IR): a
  // declared status wins, a read/delete is 200 and a write is 201.
  const successStatus = String(contractSuccessStatus(op));
  const success: Record<string, unknown> = { description: 'ok' };
  // B92.2: a file answer publishes the declared media type and a binary schema,
  // so a generated client reads bytes and the download name from the contract
  // instead of guessing a JSON shape.
  const file = op.clauses.find((clause) => clause.kind === 'file');
  if (file && file.kind === 'file') {
    success.content = { [file.contentType]: { schema: { type: 'string', format: 'binary' } } };
    success.headers = {
      'content-disposition': {
        description: 'attachment; filename="' + file.filename + '"',
        schema: { type: 'string' },
      },
    };
  } else if (op.returns && !(op.returns.kind === 'named' && (op.returns.name === 'void' || op.returns.name === 'null'))) {
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
    const schema = withDefault(schemaFor(mod, param.type), param, mod);
    const optional = param.type.kind === 'optional' || param.default !== undefined;
    if (where === 'body') {
      // The body itself is optional until a required field appears: a client
      // may omit the whole body when every field has a default or is optional.
      requestBody ??= {
        required: false,
        content: { 'application/json': { schema: { type: 'object', properties: {} as Record<string, unknown> } } },
      };
      const bodySchema = (requestBody.content as Record<string, Record<string, unknown>>)['application/json'].schema as Record<string, unknown>;
      putKey(bodySchema.properties as Record<string, unknown>, param.name, schema);
      if (!optional) {
        requestBody.required = true;
        ((bodySchema.required ??= []) as string[]).push(param.name);
      }
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
  // OpenAPI cannot express roles or ownership, but the runtime enforces them
  // before the body runs: a client author has to read that somewhere.
  const access = accessNotes(op);
  if (access.length > 0) operation.description = access.join('. ') + '.';
  if (parameters.length > 0) operation.parameters = parameters;
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

export function emitOpenapi(mod: ModuleNode, options: OpenapiOptions = {}): OpenapiDocument {
  // A module may declare several services. Naming one keeps the historical
  // behaviour; without a name every internal service contributes its paths,
  // so the document cannot silently describe half of the module. Two services
  // that declare the same route are refused: one operation would overwrite the
  // other and the reader would never learn it.
  const own = mod.services.filter((item) => !item.external);
  const targets = options.service
    ? mod.services.filter((item) => item.name === options.service)
    : own.length > 0 ? own : [];
  if (targets.length === 0) throw new Error(options.service ? 'no service named ' + options.service + ' to emit OpenAPI for' : 'no service to emit OpenAPI for');

  const examplesByService = new Map<ServiceNode, ReturnType<typeof interpretExamples>>();
  const routed = (svc: ServiceNode): boolean => svc.contract.some((op) => op.kind === 'op' && routeOf(op) !== null);
  // A service that verifies tokens has a real security scheme: the runtime
  // reads a bearer token from the Authorization header, so the contract
  // publishes the scheme instead of leaving the client to guess. A scheme
  // nobody needs is noise: publish it only when a routed operation actually
  // inherits it (a public-only service gets no `security` key).
  const bearerOf = (svc: ServiceNode): boolean =>
    svc.uses.some((use) => use.capability === 'identity' || use.capability.endsWith('.identity'))
    && svc.contract.some((op) => op.kind === 'op' && op.auth && routeOf(op) !== null);
  const bearer = targets.some(bearerOf);
  const paths: Record<string, unknown> = {};
  const declaredBy = new Map<string, string>();

  for (const svc of targets) {
    const examples = interpretExamples(svc);
    examplesByService.set(svc, examples);
    const guarded = bearerOf(svc);

    for (const op of svc.contract) {
      if (op.kind !== 'op' || !routeOf(op)) continue; // A050 covers the no-route case
      if (!svc.external && !op.isPublic && !op.auth) continue; // auth ops are public surface too // an external contract is entirely public surface
      const { method, path } = routeInfo(op);
      const key = method.toUpperCase() + ' ' + path;
      const previous = declaredBy.get(key);
      if (previous) {
        throw new Error('route ' + method.toUpperCase() + ' ' + path + ' is declared by both ' + previous + ' and ' + svc.name + '.' + op.name + '; pass --service <name> to emit one service');
      }
      declaredBy.set(key, svc.name + '.' + op.name);
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
      if (guarded && op.isPublic) operation.security = []; // public overrides the document default
      // Several services in one document cannot share a default: a service
      // without identity must not inherit a bearer requirement. The single
      // service case keeps the document-level default it always had.
      else if (guarded && targets.length > 1) operation.security = [{ bearerAuth: [] }];
      pathItem[method.toLowerCase()] = operation;
    }
  }

  const document: OpenapiDocument = {
    openapi: '3.1.0',
    info: {
      title: mod.name,
      version: mod.version,
    },
    paths,
    components: { schemas: components(mod) },
  };
  if (bearer) {
    (document.components as Record<string, unknown>).securitySchemes = {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'access token issued by the identity provider',
      },
    };
    if (targets.length === 1) document.security = [{ bearerAuth: [] }];
  }
  return document;
}
