// adopt: reverse of `arcod openapi`. Reads an OpenAPI 3.x document and emits an
// .arc module: schemas become types (or enums), each path+method becomes an op
// with a route, parameters/requestBody become params, a 200 schema becomes the
// return type. Best-effort: unsupported JSON-schema corners fall back to a
// conservative named type or `string`; security/models are read only as far as
// `auth op` (a bearer requirement) and are otherwise dropped.

import type {
  Loc, ModuleNode, OpNode, Param, ServiceNode, TypeArg, TypeDecl, TypeExpr,
} from './ast.ts';
import { printModule } from './fmt.ts';
import { BUILTIN_TYPE_NAMES } from './check.ts';

const LOC: Loc = { line: 0, col: 0, endLine: 0, endCol: 0, offset: 0, end: 0 };
const loc = (): Loc => LOC;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function ident(text: string): string {
  let s = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'op';
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

// A document may name a schema `int` or `number`. A declaration with a
// builtin name is A089, so the adopted module renames it instead of emitting
// a file its own checker rejects. Every $ref goes through the same function,
// so the declaration and its references stay in step.
function declName(text: string): string {
  const name = ident(text);
  return BUILTIN_TYPE_NAMES.has(name) ? name + '_' : name;
}

function typeName(ref: string): string {
  const parts = ref.split('/');
  return declName(parts[parts.length - 1]);
}

function named(name: string, args: TypeArg[] = []): TypeExpr {
  return { kind: 'named', name, args, loc: loc() };
}

function numericArg(name: string, value: number): TypeArg {
  return { name, value: { kind: 'literal', value, raw: String(value), loc: loc() }, loc: loc() };
}

// A string keeps the format it declares: `format: uuid` is the same fact as the
// `uuid` type, and `minLength`/`maxLength` are the `string(min, max)` arguments
// the checker and the runtime already enforce. Adopting an API must not widen
// what it accepts.
function stringType(schema: any): TypeExpr {
  const format = typeof schema.format === 'string' ? schema.format : null;
  if (format === 'uuid') return named('uuid');
  if (format === 'date-time') return named('datetime');
  if (format === 'email') return named('email');
  if (format === 'uri' || format === 'url') return named('url');
  const args: TypeArg[] = [];
  if (typeof schema.minLength === 'number') args.push(numericArg('min', schema.minLength));
  if (typeof schema.maxLength === 'number') args.push(numericArg('max', schema.maxLength));
  return named('string', args);
}

function schemaType(schema: any, typeNames: Set<string>): TypeExpr {
  if (!schema || typeof schema !== 'object') return named('string');
  if (schema.$ref) return named(typeName(schema.$ref));
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const list = schema.oneOf ?? schema.anyOf;
    const variants = list.map((s: any) => schemaType(s, typeNames));
    if (variants.length === 1) return variants[0];
    return { kind: 'union', variants, loc: loc() };
  }
  if (schema.enum && Array.isArray(schema.enum)) {
    // inline enum: collapse to string unless it is a named top-level schema
    return named('string');
  }
  if (schema.type === 'array') {
    return {
      kind: 'named',
      name: 'list',
      args: [{ value: schemaType(schema.items ?? {}, typeNames), isType: true, loc: loc() }],
      loc: loc(),
    };
  }
  if (schema.type === 'object' || schema.properties) {
    const required: string[] = schema.required ?? [];
    const fields: Param[] = [];
    for (const [name, sub] of Object.entries<any>(schema.properties ?? {})) {
      let t = schemaType(sub, typeNames);
      if (!required.includes(name)) t = { kind: 'optional', inner: t, loc: loc() };
      fields.push({ name: ident(name), type: t, loc: loc() });
    }
    return { kind: 'record', fields, loc: loc() };
  }
  switch (schema.type) {
    case 'integer': {
      // Bounds are part of the contract the document states; dropping them
      // would make the adopted spec accept what the original rejected. An
      // integer bound is the tightest whole number the document allows:
      // minimum 1.5 is min 2, exclusiveMinimum 0 is min 1 (OpenAPI 3.0 spells
      // it minimum + exclusiveMinimum: true, 3.1 a number).
      let minimum = typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : null;
      let maximum = typeof schema.maximum === 'number' ? Math.floor(schema.maximum) : null;
      if (typeof schema.exclusiveMinimum === 'number') {
        minimum = Math.max(minimum ?? -Infinity, Math.floor(schema.exclusiveMinimum) + 1);
      } else if (schema.exclusiveMinimum === true && minimum !== null) {
        minimum += 1;
      }
      if (typeof schema.exclusiveMaximum === 'number') {
        maximum = Math.min(maximum ?? Infinity, Math.ceil(schema.exclusiveMaximum) - 1);
      } else if (schema.exclusiveMaximum === true && maximum !== null) {
        maximum -= 1;
      }
      const args: TypeArg[] = [];
      if (minimum !== null) args.push(numericArg('min', minimum));
      if (maximum !== null) args.push(numericArg('max', maximum));
      return args.length > 0 ? { kind: 'named', name: 'int', args, loc: loc() } : named('int');
    }
    case 'number': return named('number');
    case 'boolean': return named('bool');
    case 'string':
    default: return stringType(schema);
  }
}

function buildTypes(components: any): { types: TypeDecl[]; enumDecls: { kind: string; name: string; values: string[]; loc: Loc }[] } {
  const types: TypeDecl[] = [];
  const enumDecls: { kind: string; name: string; values: string[]; loc: Loc }[] = [];
  const schemas: Record<string, any> = components?.schemas ?? {};
  for (const [rawName, schema] of Object.entries<any>(schemas)) {
    const name = declName(rawName);
    if (schema?.enum && Array.isArray(schema.enum)) {
      enumDecls.push({ kind: 'enum', name, values: schema.enum.map((v: any) => ident(String(v))), loc: loc() });
      continue;
    }
    types.push({ kind: 'type', name, type: schemaType(schema, new Set()), loc: loc() });
  }
  return { types, enumDecls };
}

// OpenAPI spells a capture as `{id}`; Arcod spells it `:id`. Without this the
// adopted route is a literal segment, so the service would answer a URL that
// contains braces and ignore the parameter the contract declares.
function arcodPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (/^\{[^{}]+\}$/.test(segment) ? ':' + ident(segment.slice(1, -1)) : segment))
    .join('/');
}

function buildOps(paths: Record<string, any>, documentSecurity: any[] | null): OpNode[] {
  const ops: OpNode[] = [];
  for (const [path, item] of Object.entries<any>(paths ?? {})) {
    for (const method of METHODS) {
      const spec = item?.[method];
      if (!spec) continue;
      const opName = ident(spec.operationId ?? (method + '_' + path));
      // An operation without its own `security` inherits the document default;
      // an explicit `security: []` is how a public operation opts out.
      const security = spec.security !== undefined ? spec.security : documentSecurity;
      const guarded = Array.isArray(security) && security.length > 0;
      const params: Param[] = [];
      const paramSpecs: any[] = Array.isArray(spec.parameters) ? spec.parameters : [];
      for (const p of paramSpecs) {
        let t = schemaType(p.schema ?? {}, new Set());
        if (p.required !== true) t = { kind: 'optional', inner: t, loc: loc() };
        params.push({ name: ident(p.name), type: t, loc: loc() });
      }
      if (spec.requestBody) {
        const schema = spec.requestBody.content?.['application/json']?.schema ?? spec.requestBody.schema;
        params.push({ name: 'body', type: schemaType(schema ?? {}, new Set()), loc: loc() });
      }
      let returns: TypeExpr | null = null;
      const ok = spec.responses?.['200'] ?? spec.responses?.['201'] ?? spec.responses?.['default'];
      // A string result is emitted as text/plain, not JSON; both are the same
      // declared return type to the model.
      const okSchema = ok?.content?.['application/json']?.schema ?? ok?.content?.['text/plain']?.schema ?? ok?.schema;
      if (okSchema) returns = schemaType(okSchema, new Set());

      ops.push({
        kind: 'op',
        name: opName,
        isPublic: !guarded,
        auth: guarded,
        params,
        returns,
        clauses: [{ kind: 'route', value: method.toUpperCase() + ' ' + arcodPath(path), loc: loc() }],
        loc: loc(),
      });
    }
  }
  return ops;
}

// `adopt` is the reverse of `arcod openapi`, which publishes OpenAPI 3.x.
// Swagger 2.0 looks close enough to parse but differs where it matters: the
// path prefix lives in basePath, models in definitions, and a JSON body is a
// parameter with `in: body`. Adopting one as if it were 3.x would silently
// drop the prefix and the models, so refuse it by name instead.
export function adoptOpenapi(doc: any): string {
  const version = typeof doc?.openapi === 'string' ? doc.openapi.trim() : '';
  if (!version) {
    if (typeof doc?.swagger === 'string') {
      throw new Error('adopt reads OpenAPI 3.x; this document is Swagger ' + doc.swagger + ' (convert it to OpenAPI 3 first)');
    }
    throw new Error('adopt reads OpenAPI 3.x; the document has no "openapi" version field');
  }
  if (!/^3(\.|$)/.test(version)) {
    throw new Error('adopt reads OpenAPI 3.x; this document declares ' + version);
  }
  const title = doc?.info?.title ? ident(doc.info.title) : 'service';
  const { types, enumDecls } = buildTypes(doc?.components);
  const documentSecurity = Array.isArray(doc?.security) ? doc.security : null;
  const ops = buildOps(doc?.paths, documentSecurity);
  const guarded = ops.some((op) => op.auth);

  const svc: ServiceNode = {
    kind: 'service',
    name: title,
    impl: 'http',
    external: false,
    meta: {},
    uses: guarded ? [{ kind: 'uses', alias: 'auth', capability: 'identity', params: {}, loc: loc() }] : [],
    contract: ops,
    sagas: [],
    rules: [],
    roles: [],
    effects: null,
    examples: [],
    budget: null,
    loc: loc(),
  };

  const mod: ModuleNode = {
    kind: 'module',
    name: title,
    version: '0.1.0',
    meta: {},
    uses: guarded ? [{ kind: 'use', what: 'capability', name: 'arcod.std.identity', version: '1', loc: loc() }] : [],
    types,
    errors: [],
    enums: enumDecls as any,
    services: [svc],
    workflows: [],
    environments: guarded
      ? [{
          kind: 'environment',
          name: 'dev',
          binds: [{ kind: 'bind', alias: 'auth', provider: 'keycloak', args: {}, guarantees: [], loc: loc() }],
          deploy: null,
          loc: loc(),
        }]
      : [],
    uis: [],
    file: 'main.arc',
    source: '',
    loc: loc(),
  };

  return printModule(mod);
}
