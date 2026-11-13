// gRPC (proto3) emitter. Same contract, third rendering: HTTP stays the
// runtime transport, OpenAPI and GraphQL describe it for HTTP and GraphQL
// clients, and this file gives gRPC clients and codegen something real to
// compile against.
//
// The mapping is mechanical and documented in the README:
//   uuid -> string, datetime -> google.protobuf.Timestamp, json -> Value,
//   map -> map<K,V>, decimal -> string (precision survives), void -> empty.
// Route and error annotations live in comments so the transport cannot drift
// away from the contract silently.

import type {
  EnumDecl,
  ModuleNode,
  OpNode,
  Param,
  ServiceNode,
  TypeExpr,
} from '../ast.ts';
import { pickService, routeOf, statusForError } from './service.ts';

export interface GrpcOptions {
  service?: string;
}

const SCALARS: Record<string, string> = {
  string: 'string',
  bytes: 'bytes',
  uuid: 'string',
  int: 'int64',
  number: 'double',
  float: 'double',
  decimal: 'string',
  bool: 'bool',
  boolean: 'bool',
  datetime: 'google.protobuf.Timestamp',
  json: 'google.protobuf.Value',
  map: 'google.protobuf.Struct',
  null: 'google.protobuf.NullValue',
};

// Arcod error names carry HTTP statuses; gRPC has its own code space, so the
// mapping is explicit rather than implied by the number.
const GRPC_CODES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  422: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

function upperSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
    .replace(/^_+|_+$/g, '');
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
  readonly messages = new Map<string, string[]>();
  readonly enums = new Map<string, string>();
  readonly imports = new Set<string>();
  private readonly mod: ModuleNode;

  constructor(mod: ModuleNode) {
    this.mod = mod;
  }

  private declOf(name: string): TypeExpr | null {
    let name2 = name;
    for (let depth = 0; depth < 16; depth += 1) {
      const decl = this.mod.types.find((item) => item.name === name2);
      if (!decl) return null;
      if (decl.type.kind !== 'named') return decl.type;
      if (decl.type.name === name2) return decl.type;
      // Stop at a builtin, an enum or a record: that is the real shape.
      if (SCALARS[decl.type.name] || isEnumDecl(this.mod, decl.type.name) || isRecordDecl(this.mod, decl.type.name)) {
        return decl.type;
      }
      name2 = decl.type.name;
    }
    return null;
  }

  private recordFields(name: string): Param[] {
    const decl = this.mod.types.find((item) => item.name === name);
    return decl && decl.type.kind === 'record' ? decl.type.fields : [];
  }

  // Returns the proto type name for a value position plus the labels that go
  // before it (repeated, optional): proto3 has no nullable types.
  typeOf(type: TypeExpr, hint: string): { type: string; labels: string[] } {
    if (type.kind === 'optional') {
      const inner = this.typeOf(type.inner, hint);
      return { type: inner.type, labels: ['optional', ...inner.labels.filter((item) => item !== 'repeated')] };
    }
    if (type.kind === 'record') {
      return { type: this.message(hint, type.fields), labels: [] };
    }
    if (type.kind === 'union') {
      return { type: this.union(hint, type.variants), labels: [] };
    }
    const name = type.name;
    if (name === 'list') {
      const arg = type.args.find((item) => item.isType);
      if (!arg) return { type: 'google.protobuf.Value', labels: ['repeated'] };
      const element = this.typeOf(arg.value as TypeExpr, hint + 'Item');
      return { type: element.type, labels: ['repeated'] };
    }
    if (name === 'map') {
      const args = type.args.filter((item) => item.isType).map((item) => item.value as TypeExpr);
      const key = args[0];
      const value = args[1];
      if (key && value && key.kind === 'named' && ['string', 'uuid', 'int'].includes(key.name) && value.kind === 'named' && ['string', 'uuid', 'int', 'bool'].includes(value.name)) {
        return { type: 'map<' + this.typeOf(key, hint + 'Key').type + ', ' + this.typeOf(value, hint + 'Value').type + '>', labels: [] };
      }
      this.imports.add('google/protobuf/struct.proto');
      return { type: 'google.protobuf.Struct', labels: [] };
    }
    const scalar = SCALARS[name];
    if (scalar) {
      if (scalar.startsWith('google.protobuf.')) {
        const file = scalar === 'google.protobuf.Timestamp' ? 'google/protobuf/timestamp.proto' : 'google/protobuf/struct.proto';
        this.imports.add(file);
      }
      return { type: scalar, labels: [] };
    }
    if (isEnumDecl(this.mod, name)) {
      this.enumFor(name);
      return { type: name, labels: [] };
    }
    if (isRecordDecl(this.mod, name)) {
      return { type: this.message(name, this.recordFields(name)), labels: [] };
    }
    const decl = this.declOf(name);
    if (decl && decl.kind === 'record') return { type: this.message(name, decl.fields), labels: [] };
    if (decl && decl.kind === 'named' && decl.name !== name) return this.typeOf(decl, hint);
    if (decl && decl.kind !== 'named') return this.typeOf(decl, hint);
    // A hole in the contract: Value keeps the file compilable and the gap visible.
    this.imports.add('google/protobuf/struct.proto');
    return { type: 'google.protobuf.Value', labels: [] };
  }

  private enumFor(name: string): void {
    if (this.enums.has(name)) return;
    const decl: EnumDecl | undefined = this.mod.enums.find((item) => item.name === name);
    if (!decl) return;
    const prefix = upperSnake(name);
    const lines = ['enum ' + name + ' {'];
    lines.push('  ' + prefix + '_UNSPECIFIED = 0;');
    decl.values.forEach((value, index) => {
      lines.push('  ' + prefix + '_' + upperSnake(value) + ' = ' + (index + 1) + ';');
    });
    lines.push('}');
    this.enums.set(name, lines.join('\n'));
  }

  private union(hint: string, variants: TypeExpr[]): string {
    const records = variants.map((variant) => (variant.kind === 'named' ? variant.name : null));
    const usable = records.every((name) => name !== null && isRecordDecl(this.mod, name));
    if (!usable) {
      // proto3 has no anonymous sum type; Value is the honest fallback.
      this.imports.add('google/protobuf/struct.proto');
      return 'google.protobuf.Value';
    }
    if (this.messages.has(hint)) return hint;
    this.messages.set(hint, []);
    const lines = ['message ' + hint + ' {', '  oneof value {'];
    records.forEach((name, index) => {
      const variant = variants[index]!;
      const ref = this.typeOf(variant, hint + 'Variant' + (index + 1));
      lines.push('    ' + ref.type + ' ' + name!.toLowerCase() + ' = ' + (index + 1) + ';');
    });
    lines.push('  }', '}');
    this.messages.set(hint, lines);
    return hint;
  }

  message(name: string, fields: Param[]): string {
    if (this.messages.has(name)) return name;
    this.messages.set(name, []);
    const lines = ['message ' + name + ' {'];
    fields.forEach((field, index) => {
      const rendered = this.typeOf(field.type, name + pascal(field.name));
      const needsPresence = field.default !== undefined
        && !rendered.labels.includes('optional')
        && !rendered.labels.includes('repeated');
      const labels = needsPresence ? ['optional', ...rendered.labels] : rendered.labels;
      lines.push('  ' + [...labels, rendered.type, field.name + ' = ' + (index + 1) + ';'].join(' '));
    });
    lines.push('}');
    this.messages.set(name, lines);
    return name;
  }

  // Messages are appended while earlier ones are being built, so the registry
  // is drained by scanning for names not yet printed rather than iterated once.
  drain(): string[] {
    const blocks: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      const next = [...this.messages.keys()].find((name) => !seen.has(name));
      if (!next) break;
      seen.add(next);
      blocks.push(this.messages.get(next)!.join('\n'));
    }
    for (const name of [...this.enums.keys()].sort()) blocks.push(this.enums.get(name)!);
    return blocks;
  }
}

function methodComment(op: OpNode): string[] {
  const lines: string[] = [];
  const route = routeInfo(op);
  if (route) lines.push('  // HTTP: ' + route.method + ' ' + route.path);
  const errors = errorNamesOf(op);
  if (errors.length > 0) {
    const codes = errors.map((name) => name + ' (' + (GRPC_CODES[statusForError(name)] ?? 'UNKNOWN') + ')');
    lines.push('  // Errors: ' + codes.join(', '));
  }
  return lines;
}

function requestMessage(registry: Registry, op: OpNode): string {
  return registry.message(pascal(op.name) + 'Request', op.params);
}

function responseMessage(registry: Registry, op: OpNode): string {
  const name = pascal(op.name) + 'Response';
  if (!op.returns || (op.returns.kind === 'named' && op.returns.name === 'void')) {
    return registry.message(name, []);
  }
  const rendered = registry.typeOf(op.returns, name + 'Result');
  const labels = rendered.labels.length > 0 ? rendered.labels : [];
  registry.messages.set(name, ['message ' + name + ' {', '  ' + [...labels, rendered.type, 'result = 1;'].join(' '), '}']);
  return name;
}

export function grpcProto(mod: ModuleNode, options: GrpcOptions = {}): string {
  const svc: ServiceNode | null = options.service
    ? mod.services.find((item) => item.name === options.service) ?? null
    : pickService(mod);
  if (!svc) throw new Error('no service to emit gRPC for');

  const registry = new Registry(mod);
  const methods: string[] = [];
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    if (!routeInfo(op)) continue;
    if (methods.length > 0) methods.push('');
    methods.push(...methodComment(op));
    methods.push('  rpc ' + pascal(op.name) + '(' + requestMessage(registry, op) + ') returns (' + responseMessage(registry, op) + ');');
  }

  const header: string[] = [
    '// Generated by arcod from module ' + mod.name + ' @' + mod.version + ' (service ' + svc.name + ').',
    '// HTTP remains the runtime transport; this file is the gRPC client contract.',
    'syntax = "proto3";',
    '',
    'package arcod.' + mod.name.replace(/[^A-Za-z0-9_]/g, '_') + ';',
  ];

  const serviceBlock = ['service ' + pascal(svc.name) + ' {', ...methods, '}'].join('\n');
  const blocks: string[] = [serviceBlock, ...registry.drain()];

  const imports = [...registry.imports].sort();
  const body: string[] = [];
  if (imports.length > 0) body.push('', ...imports.map((item) => 'import "' + item + '";'));
  body.push('', blocks.join('\n\n'));
  return header.join('\n') + '\n' + body.join('\n') + '\n';
}
