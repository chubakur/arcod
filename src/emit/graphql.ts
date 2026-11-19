// GraphQL SDL emitter. Same role as the OpenAPI emitter: the generated
// runtime speaks HTTP, and the schema is the stable client contract. Every
// field mirrors one operation one-to-one, and the field's description carries
// the HTTP route, so a client can move between the two without guessing.
//
// The split follows the REST method, not a naming convention: a GET route
// becomes a Query field, anything else a Mutation. Providers, hosts and
// storage never appear here — the schema names only what the contract names.

import type {
  EnumDecl,
  ModuleNode,
  OpNode,
  Param,
  ServiceNode,
  TypeExpr,
} from '../ast.ts';
import { accessNotes, pickService, routeOf, statusForError } from './service.ts';

export interface GraphqlOptions {
  service?: string;
}

interface Ref {
  ref: string;
  nonNull: boolean;
}

type Mode = 'out' | 'in';

// Builtins the language knows, mapped onto GraphQL's five scalars where the
// meaning survives the trip and onto custom scalars where it does not.
const SCALARS: Record<string, string> = {
  string: 'String',
  bytes: 'String',
  uuid: 'ID',
  int: 'Int',
  number: 'Float',
  float: 'Float',
  decimal: 'Decimal',
  bool: 'Boolean',
  boolean: 'Boolean',
  datetime: 'DateTime',
  json: 'JSON',
  map: 'JSON',
  void: 'Void',
  null: 'Void',
};

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

function errorNamesOf(op: OpNode): string[] {
  const clause = op.clauses.find((item) => item.kind === 'errors');
  return clause && clause.kind === 'errors' ? clause.names : [];
}

function routeInfo(op: OpNode): { method: string; path: string } | null {
  const value = routeOf(op);
  if (!value) return null;
  const [method, path] = value.split(/\s+/);
  return { method: (method || 'GET').toUpperCase(), path: path || '/' };
}

function isRecordDecl(mod: ModuleNode, name: string): boolean {
  const decl = mod.types.find((item) => item.name === name);
  return Boolean(decl && decl.type.kind === 'record');
}

function isEnumDecl(mod: ModuleNode, name: string): boolean {
  return mod.enums.some((item) => item.name === name);
}

class Registry {
  readonly outputs = new Map<string, string>();
  readonly inputs = new Map<string, string>();
  readonly scalars = new Set<string>();

  private readonly mod: ModuleNode;

  constructor(mod: ModuleNode) {
    this.mod = mod;
  }

  private declOf(name: string): TypeExpr | null {
    let current: TypeExpr | null = null;
    let name2 = name;
    for (let depth = 0; depth < 16; depth += 1) {
      const decl = this.mod.types.find((item) => item.name === name2);
      if (!decl) return current;
      current = decl.type;
      if (decl.type.kind !== 'named') return current;
      if (decl.type.name === name2) return current;
      if (SCALARS[decl.type.name] || isEnumDecl(this.mod, decl.type.name) || isRecordDecl(this.mod, decl.type.name)) {
        return decl.type;
      }
      name2 = decl.type.name;
    }
    return current;
  }

  ref(type: TypeExpr, hint: string, mode: Mode): Ref {
    if (type.kind === 'optional') {
      const inner = this.ref(type.inner, hint, mode);
      return { ref: inner.ref, nonNull: false };
    }
    if (type.kind === 'record') {
      return { ref: this.record(hint, type.fields, mode), nonNull: true };
    }
    if (type.kind === 'union') {
      return { ref: this.union(hint, type.variants, mode), nonNull: true };
    }
    const name = type.name;
    if (name === 'list') {
      const arg = type.args.find((item) => item.isType);
      if (!arg) return { ref: '[JSON!]', nonNull: true };
      const element = this.ref(arg.value as TypeExpr, hint + 'Item', mode);
      return { ref: '[' + element.ref + (element.nonNull ? '!' : '') + ']', nonNull: true };
    }
    if (SCALARS[name]) {
      const scalar = SCALARS[name]!;
      this.scalars.add(scalar);
      return { ref: scalar, nonNull: true };
    }
    if (isEnumDecl(this.mod, name)) return { ref: name, nonNull: true };
    if (isRecordDecl(this.mod, name)) {
      if (mode === 'in') return { ref: this.record(name, this.recordFields(name), 'in'), nonNull: true };
      return { ref: this.record(name, this.recordFields(name), 'out'), nonNull: true };
    }
    const decl = this.declOf(name);
    if (decl && decl.kind === 'union') {
      // A named union keeps its declared name: `union Result = A | B`, not a
      // hint-derived one and never the JSON hole below. A GraphQL union holds
      // object types only, though: one scalar or enum variant (`type R = Task |
      // string`) leaves a member no server accepts, so the whole position
      // becomes the hole rather than invalid SDL.
      if (!decl.variants.every((variant) => this.objectVariant(variant))) {
        this.scalars.add('JSON');
        return { ref: 'JSON', nonNull: true };
      }
      return { ref: this.union(name, decl.variants, mode), nonNull: true };
    }
    // A record cannot arrive here: isRecordDecl above already answered for
    // every declared record, and declOf stops at a record name, not at its
    // body, so the only shapes left are union, builtin alias and the hole.
    if (decl && decl.kind === 'named') return this.ref(decl, hint, mode);
    // An unknown named type is a hole in the contract; JSON keeps the schema
    // valid and makes the gap visible instead of inventing a shape.
    this.scalars.add('JSON');
    return { ref: 'JSON', nonNull: true };
  }

  // A union member in GraphQL has to be an object type: a record, an inline
  // record or an alias that resolves to one. Anything else (a builtin, an
  // enum, a list) cannot be a member.
  private objectVariant(variant: TypeExpr): boolean {
    if (variant.kind === 'optional') return this.objectVariant(variant.inner);
    if (variant.kind === 'record') return true;
    if (variant.kind !== 'named') return false;
    if (isRecordDecl(this.mod, variant.name)) return true;
    const decl = this.declOf(variant.name);
    return Boolean(decl && decl.kind === 'named' && isRecordDecl(this.mod, decl.name));
  }

  private recordFields(name: string): Param[] {
    const decl = this.mod.types.find((item) => item.name === name);
    return decl && decl.type.kind === 'record' ? decl.type.fields : [];
  }

  // GraphQL has no input unions, so an input position carries the merged
  // fields of every variant, each optional: a value of any variant satisfies it.
  private variantFields(variant: TypeExpr): Param[] {
    if (variant.kind === 'record') return variant.fields;
    if (variant.kind === 'optional') return this.variantFields(variant.inner);
    if (variant.kind === 'named') {
      const decl = this.declOf(variant.name);
      if (decl && decl.kind === 'record') return decl.fields;
      // An alias of a record is still that record's shape: declOf stops at the
      // record name (`Item = Task` resolves to a named Task), so follow one
      // hop before declaring the variant fieldless.
      if (decl && decl.kind === 'named' && isRecordDecl(this.mod, decl.name)) return this.recordFields(decl.name);
    }
    return [];
  }

  private union(name: string, variants: TypeExpr[], mode: Mode): string {
    if (mode === 'in') {
      const fields: Param[] = [];
      for (const variant of variants) {
        for (const field of this.variantFields(variant)) {
          if (fields.some((existing) => existing.name === field.name)) continue;
          fields.push({ ...field, type: { kind: 'optional', inner: field.type, loc: field.type.loc }, default: undefined });
        }
      }
      return this.record(name, fields, 'in');
    }
    if (!this.outputs.has(name)) {
      this.outputs.set(name, '__union__');
      const members = variants.map((variant, index) => this.ref(variant, name + 'Variant' + (index + 1), 'out').ref);
      this.outputs.set(name, '__union__' + members.join('|'));
    }
    return name;
  }

  private record(name: string, fields: Param[], mode: Mode): string {
    const key = mode === 'in' ? name + 'Input' : name;
    const target = mode === 'in' ? this.inputs : this.outputs;
    if (target.has(key)) return key;
    target.set(key, '');
    const lines = fields.map((field) => {
      const rendered = this.ref(field.type, key + pascal(field.name), mode);
      return '  ' + field.name + ': ' + rendered.ref + (rendered.nonNull ? '!' : '');
    });
    target.set(key, lines.join('\n'));
    return key;
  }

  render(): string[] {
    const blocks: string[] = [];
    for (const scalar of [...this.scalars].sort()) {
      if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(scalar)) continue;
      blocks.push('scalar ' + scalar);
    }
    for (const node of [...this.mod.enums].sort((a, b) => a.name.localeCompare(b.name))) {
      blocks.push(this.renderEnum(node));
    }
    for (const [name, body] of [...this.outputs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (body.startsWith('__union__')) {
        const members = body.slice('__union__'.length).split('|').filter((item) => item.length > 0);
        blocks.push('union ' + name + ' = ' + members.join(' | '));
        continue;
      }
      blocks.push('type ' + name + ' {\n' + body + '\n}');
    }
    for (const [name, body] of [...this.inputs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      blocks.push('input ' + name + ' {\n' + body + '\n}');
    }
    return blocks;
  }

  private renderEnum(node: EnumDecl): string {
    return 'enum ' + node.name + ' {\n' + node.values.map((value) => '  ' + value).join('\n') + '\n}';
  }
}

function fieldDescription(op: OpNode): string[] {
  const lines: string[] = [];
  const route = routeInfo(op);
  if (route) lines.push('HTTP: ' + route.method + ' ' + route.path);
  const errors = errorNamesOf(op);
  if (errors.length > 0) {
    lines.push('Errors: ' + errors.map((name) => name + ' (' + statusForError(name) + ')').join(', '));
  }
  for (const note of accessNotes(op)) lines.push(note + '.');
  return lines;
}

function rootField(registry: Registry, op: OpNode): string {
  const args = op.params.map((param) => {
    const hint = pascal(op.name) + pascal(param.name);
    const rendered = registry.ref(param.type, hint, 'in');
    const required = rendered.nonNull && param.default === undefined;
    return param.name + ': ' + rendered.ref + (required ? '!' : '');
  });
  const returns = op.returns && !(op.returns.kind === 'named' && op.returns.name === 'void')
    ? registry.ref(op.returns, pascal(op.name) + 'Result', 'out')
    : { ref: 'Boolean', nonNull: true };
  const signature = '  ' + op.name + (args.length > 0 ? '(' + args.join(', ') + ')' : '') + ': ' + returns.ref + (returns.nonNull ? '!' : '');
  const description = fieldDescription(op);
  if (description.length === 0) return signature;
  return '  """\n' + description.map((line) => '  ' + line).join('\n') + '\n  """\n' + signature;
}

export function graphqlSchema(mod: ModuleNode, options: GraphqlOptions = {}): string {
  const svc: ServiceNode | null = options.service
    ? mod.services.find((item) => item.name === options.service) ?? null
    : pickService(mod);
  if (!svc) throw new Error(options.service ? 'no service named ' + options.service + ' to emit GraphQL for' : 'no service to emit GraphQL for');

  const registry = new Registry(mod);
  const roots: { method: string; field: string }[] = [];
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const route = routeInfo(op);
    if (!route) continue;
    roots.push({ method: route.method, field: rootField(registry, op) });
  }

  const queries = roots.filter((item) => item.method === 'GET' || item.method === 'HEAD');
  const mutations = roots.filter((item) => item.method !== 'GET' && item.method !== 'HEAD');

  const blocks: string[] = [];
  const lines: string[] = [
    '# GraphQL schema generated from module ' + mod.name + ' @' + mod.version + ' (service ' + svc.name + ').',
    '# The runtime transport is HTTP; this schema is the client contract.',
    '# Fields marked with an HTTP description map onto the REST route of the same name.',
  ];
  if (queries.length > 0) {
    blocks.push('type Query {\n' + queries.map((item) => item.field).join('\n\n') + '\n}');
  }
  if (mutations.length > 0) {
    blocks.push('type Mutation {\n' + mutations.map((item) => item.field).join('\n\n') + '\n}');
  }
  blocks.push(...registry.render());
  if (queries.length === 0 && mutations.length === 0) {
    lines.push('# No routed operation was found: the schema has no root fields.');
  }
  return lines.join('\n') + '\n\n' + blocks.join('\n\n') + '\n';
}
