// adopt: reverse of `arcod openapi`. Reads an OpenAPI 3.x document and emits an
// .arc module: schemas become types (or enums), each path+method becomes an op
// with a route, parameters/requestBody become params, a 200 schema becomes the
// return type. Best-effort: unsupported JSON-schema corners fall back to a
// conservative named type or `string`, and security/models are dropped.

import type {
  Loc, ModuleNode, OpNode, Param, ServiceNode, TypeDecl, TypeExpr,
} from './ast.ts';
import { printModule } from './fmt.ts';

const LOC: Loc = { line: 0, col: 0, endLine: 0, endCol: 0, offset: 0, end: 0 };
const loc = (): Loc => LOC;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function ident(text: string): string {
  let s = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'op';
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

function typeName(ref: string): string {
  const parts = ref.split('/');
  return ident(parts[parts.length - 1]);
}

function named(name: string): TypeExpr {
  return { kind: 'named', name, args: [], loc: loc() };
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
    case 'integer': return named('int');
    case 'number': return named('number');
    case 'boolean': return named('bool');
    case 'string':
    default: return named('string');
  }
}

function buildTypes(components: any): { types: TypeDecl[]; enumDecls: { kind: string; name: string; values: string[]; loc: Loc }[] } {
  const types: TypeDecl[] = [];
  const enumDecls: { kind: string; name: string; values: string[]; loc: Loc }[] = [];
  const schemas: Record<string, any> = components?.schemas ?? {};
  for (const [rawName, schema] of Object.entries<any>(schemas)) {
    const name = ident(rawName);
    if (schema?.enum && Array.isArray(schema.enum)) {
      enumDecls.push({ kind: 'enum', name, values: schema.enum.map((v: any) => ident(String(v))), loc: loc() });
      continue;
    }
    types.push({ kind: 'type', name, type: schemaType(schema, new Set()), loc: loc() });
  }
  return { types, enumDecls };
}

function buildOps(paths: Record<string, any>): OpNode[] {
  const ops: OpNode[] = [];
  for (const [path, item] of Object.entries<any>(paths ?? {})) {
    for (const method of METHODS) {
      const spec = item?.[method];
      if (!spec) continue;
      const opName = ident(spec.operationId ?? (method + '_' + path));
      const params: Param[] = [];
      const paramSpecs: any[] = Array.isArray(spec.parameters) ? spec.parameters : [];
      for (const p of paramSpecs) {
        if (p.in === 'body') {
          params.push({ name: 'body', type: schemaType(p.schema ?? {}, new Set()), loc: loc() });
          continue;
        }
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
      const okSchema = ok?.content?.['application/json']?.schema ?? ok?.schema;
      if (okSchema) returns = schemaType(okSchema, new Set());

      ops.push({
        kind: 'op',
        name: opName,
        isPublic: true,
        auth: false,
        params,
        returns,
        clauses: [{ kind: 'route', value: method.toUpperCase() + ' ' + path, loc: loc() }],
        loc: loc(),
      });
    }
  }
  return ops;
}

export function adoptOpenapi(doc: any): string {
  const title = doc?.info?.title ? ident(doc.info.title) : 'service';
  const { types, enumDecls } = buildTypes(doc?.components);
  const ops = buildOps(doc?.paths);

  const svc: ServiceNode = {
    kind: 'service',
    name: title,
    impl: 'http',
    external: false,
    meta: {},
    uses: [],
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
    uses: [],
    types,
    errors: [],
    enums: enumDecls as any,
    services: [svc],
    workflows: [],
    environments: [],
    uis: [],
    file: 'main.arc',
    source: '',
    loc: loc(),
  };

  return printModule(mod);
}
