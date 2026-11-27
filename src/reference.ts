// Reference mode: bodies derived from the contract, not a fixed demo.
//
// The built-in handlers used to be the one-time-message pair: create wrote the
// body under `msg:<id>` and answered `{ id, expiresIn }`, read consumed it and
// answered text/plain. That contradicted the contract of any other service:
// project1 declares create(author, body) -> MessageId and read -> { author,
// body }, and the demo dropped `author` and answered a different type (B53).
//
// This module reads the declaration and writes the body a CRUD operation
// implies:
//   create  -> a record from the parameters (or the single record parameter)
//   read    -> a lookup by the path id; it deletes only when the contract
//              declares `once(op, ...)`, because that rule is the contract
//   update  -> a patch on the stored record, NotFound when it is absent
//   delete  -> a removal, answering the declared type
//   list    -> a scan/find with the query parameters as equality filters
//
// A declared record type gives the entity-backed io.insert/fetch/update/remove/
// find; without one the value pair io.get/io.set/io.load/io.save is the store,
// so a service like project1 (a uuid plus an anonymous record) keeps working.
// Anything else is a gap: the caller reports the operation and asks for an impl
// body instead of building a 501 that looks like a service.
import type { ModuleNode, OpNode, Param, ServiceNode, TypeExpr } from './ast.ts';
import { asOnce } from './check.ts';
import { parseRoute } from './emit/contract.ts';

export interface ReferenceBodies {
  bodies: Record<string, string>;
  gaps: Array<{ op: string; reason: string }>;
  // The entities the derived bodies store under, when the contract named one.
  entities: string[];
}

type Form = 'create' | 'read' | 'update' | 'delete' | 'list';

interface Shape {
  form: Form;
  entity: string | null;
  pathParam: string | null;
  fields: string[];
}

const FORMS: Form[] = ['create', 'read', 'update', 'delete', 'list'];

function unwrap(type: TypeExpr | null): TypeExpr | null {
  let current = type;
  while (current && current.kind === 'optional') current = current.inner;
  return current;
}

function namedRecord(mod: ModuleNode, type: TypeExpr | null): { name: string; fields: Param[] } | null {
  const inner = unwrap(type);
  if (!inner || inner.kind !== 'named') return null;
  const decl = mod.types.find((item) => item.name === inner.name);
  if (!decl || decl.type.kind !== 'record') return null;
  return { name: decl.name, fields: decl.type.fields };
}

function inlineRecord(type: TypeExpr | null): Param[] | null {
  const inner = unwrap(type);
  return inner && inner.kind === 'record' ? inner.fields : null;
}

// A record shape is either a declared type or an inline one. Only a declared
// name can be handed to io.insert/io.fetch: the runtime's STORES table is keyed
// by the declaration.
function returnsRecord(mod: ModuleNode, type: TypeExpr | null): boolean {
  return namedRecord(mod, type) !== null || inlineRecord(type) !== null;
}

function pathParams(op: OpNode): string[] {
  const route = parseRoute(op);
  if (!route) return [];
  return [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
}

function bodyParams(op: OpNode, path: string[]): Param[] {
  return op.params.filter((param) => !path.includes(param.name));
}

// The entity a body writes: a single record parameter wins, then the result
// type, then a declared record whose fields cover every parameter. Two
// candidates with the same coverage are ambiguous, and a guess would store
// under a table the contract never named.
function chooseEntity(mod: ModuleNode, op: OpNode, fields: string[], result: TypeExpr | null): string | null {
  const direct = op.params.filter((param) => namedRecord(mod, param.type));
  if (direct.length === 1) return namedRecord(mod, direct[0]!.type)!.name;
  const resultNamed = namedRecord(mod, result);
  if (resultNamed) return resultNamed.name;
  const candidates = mod.types.filter(
    (decl) =>
      decl.type.kind === 'record' &&
      fields.length > 0 &&
      fields.every((field) => decl.type.kind === 'record' && decl.type.fields.some((item) => item.name === field)),
  );
  return candidates.length === 1 ? candidates[0]!.name : null;
}

function consumeRule(svc: ServiceNode, name: string): string | null {
  for (const rule of svc.rules) {
    if (rule.kind !== 'invariant') continue;
    const once = asOnce(rule.expr);
    if (once && once.target === name) return once.elseName ?? 'Gone';
  }
  return null;
}

function declaresError(op: OpNode, name: string): boolean {
  return op.clauses.some((clause) => clause.kind === 'errors' && clause.names.includes(name));
}

// A missing record answers the declared NotFound; a service that returns an
// optional record instead answers null, and a contract that names neither has
// no honest answer, so the operation is a gap rather than a 500.
function missingAnswer(op: OpNode): string | null {
  if (declaresError(op, 'NotFound')) return "{ error: 'NotFound' }";
  const inner = unwrap(op.returns);
  if (inner && inner.kind === 'optional') return '{ result: null }';
  return null;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function shapeFor(mod: ModuleNode, op: OpNode): Shape | { gap: string } {
  const form = FORMS.find((item) => item === op.name);
  if (!form) return { gap: 'not a CRUD form (create/read/update/delete/list)' };
  const route = parseRoute(op);
  if (!route) return { gap: 'the operation has no route' };
  const path = pathParams(op);
  const fields = bodyParams(op, path).map((param) => param.name);

  if (form === 'create') {
    if (path.length > 0) return { gap: 'create carries a path parameter' };
    return { form, entity: chooseEntity(mod, op, fields, op.returns), pathParam: null, fields };
  }

  if (form === 'list') {
    if (path.length > 0) return { gap: 'list carries a path parameter' };
    const inner = unwrap(op.returns);
    const list = inner && inner.kind === 'named' && inner.name === 'list' ? (inner.args[0]?.value as TypeExpr | undefined) : undefined;
    const pageType = inner && inner.kind === 'named' ? mod.types.find((decl) => decl.name === inner.name) : undefined;
    const pageItems = pageType && pageType.type.kind === 'record'
      ? pageType.type.fields.find((field) => field.name === 'items')?.type ?? null
      : null;
    const itemType = list ?? pageItems;
    if (!itemType || !returnsRecord(mod, itemType)) return { gap: 'list does not return a list of records' };
    return { form, entity: chooseEntity(mod, op, fields, itemType), pathParam: null, fields };
  }

  // read/update/delete: exactly one path capture, the record id.
  if (path.length !== 1) return { gap: form + ' needs exactly one path parameter (the id)' };
  const pathParam = path[0]!;
  if (form === 'read' && !returnsRecord(mod, op.returns)) return { gap: 'read does not return a record or an optional record' };
  if (form === 'update' && !returnsRecord(mod, op.returns)) return { gap: 'update does not return a record' };
  if (form === 'update' && fields.length === 0) return { gap: 'update has no fields to patch' };
  return { form, entity: chooseEntity(mod, op, fields, op.returns), pathParam, fields };
}

// A value-store record has no schema, so the id has to travel with it when the
// contract's record shape names an id: otherwise read answers the fields the
// create body stored, but not the id the same contract declares.
function needsStoredId(mod: ModuleNode, svc: ServiceNode): boolean {
  return svc.contract.some((item) => {
    if (item.kind !== 'op') return false;
    const shape = namedRecord(mod, item.returns) ?? (inlineRecord(item.returns) ? { fields: inlineRecord(item.returns)! } : null);
    return Boolean(shape && shape.fields.some((field) => field.name === 'id'));
  });
}

function generatedCreate(mod: ModuleNode, svc: ServiceNode, shape: Shape, op: OpNode): string {
  const named = op.params.find((param) => namedRecord(mod, param.type));
  const idParam = op.params.find((param) => param.name === 'id');
  const value = named
    ? 'input.' + named.name
    : '{ ' + shape.fields.map((field) => field + ': input.' + field).join(', ') + ' }';
  const lines = ['export async function create(input, io) {'];
  if (shape.entity) {
    const record = idParam ? value : '{ ...' + value + ', id: io.new() }';
    lines.push('  const record = ' + record + ';');
    lines.push('  const stored = await io.insert(' + quote(shape.entity) + ', record);');
    lines.push('  return { result: ' + (returnsRecord(mod, op.returns) ? 'stored' : 'stored.id') + ' };');
  } else {
    const idField = needsStoredId(mod, svc) && !shape.fields.includes('id');
    // One id, not two: the value stored under it and the id answered must be
    // the same uuid, or a read of the returned id answers NotFound.
    lines.push(idParam ? '  const id = String(input.id);' : '  const id = io.new();');
    const stored = idField ? '{ id, ...' + value + ' }' : value;
    lines.push('  const record = ' + stored + ';');
    lines.push('  await io.set(id, record);');
    lines.push('  return { result: ' + (returnsRecord(mod, op.returns) ? 'record' : 'id') + ' };');
  }
  lines.push('}', '');
  return lines.join('\n');
}

function generatedRead(mod: ModuleNode, svc: ServiceNode, shape: Shape, op: OpNode): string {
  const missing = missingAnswer(op);
  if (!missing) return '';
  const consume = consumeRule(svc, op.name);
  const lines = [
    'export async function read(input, io) {',
    '  const id = input.' + shape.pathParam + ';',
  ];
  if (shape.entity) {
    lines.push('  const record = await io.fetch(' + quote(shape.entity) + ', id);');
    lines.push('  if (record === null) return ' + missing + ';');
    if (consume) lines.push('  if (!(await io.remove(' + quote(shape.entity) + ', id))) return { error: ' + quote(consume) + ' };');
    lines.push('  return { result: record };');
  } else {
    lines.push('  const stored = await io.load(id);');
    lines.push('  if (stored === null) return ' + (consume ? "{ error: (await io.seen(id)) ? " + quote(consume) + " : 'NotFound' }" : missing) + ';');
    if (consume) lines.push('  if (!(await io.takeIf(id, stored))) return { error: ' + quote(consume) + ' };');
    lines.push('  return { result: stored.b };');
  }
  lines.push('}', '');
  return lines.join('\n');
}

function generatedUpdate(shape: Shape, op: OpNode): string {
  const missing = missingAnswer(op);
  if (!missing) return '';
  const patch = '{ ' + shape.fields.map((field) => field + ': input.' + field).join(', ') + ' }';
  const lines = [
    'export async function update(input, io) {',
    '  const id = input.' + shape.pathParam + ';',
  ];
  if (shape.entity) {
    lines.push('  const stored = await io.update(' + quote(shape.entity) + ', id, ' + patch + ');');
    lines.push('  return { result: stored };');
  } else {
    lines.push('  const stored = await io.load(id);');
    lines.push('  if (stored === null) return ' + missing + ';');
    lines.push('  const record = { ...stored.b, ...' + patch + ' };');
    lines.push('  await io.set(id, record);');
    lines.push('  return { result: record };');
  }
  lines.push('}', '');
  return lines.join('\n');
}

function generatedDelete(mod: ModuleNode, shape: Shape, op: OpNode): string {
  const missing = missingAnswer(op);
  if (!missing) return '';
  // `delete` is not an identifier in JavaScript; the emitter renames the body
  // to implDelete from its declaration, so the suffix costs nothing.
  const lines = [
    'export async function delete_(input, io) {',
    '  const id = input.' + shape.pathParam + ';',
  ];
  if (shape.entity) {
    lines.push('  const record = await io.fetch(' + quote(shape.entity) + ', id);');
    lines.push('  if (record === null) return ' + missing + ';');
    lines.push('  await io.remove(' + quote(shape.entity) + ', id);');
  } else {
    lines.push('  const stored = await io.load(id);');
    lines.push('  if (stored === null) return ' + missing + ';');
    lines.push('  const record = stored.b;');
    lines.push('  await io.del(id);');
  }
  lines.push('  return { result: ' + (returnsRecord(mod, op.returns) ? 'record' : 'null') + ' };', '}', '');
  return lines.join('\n');
}

function generatedList(mod: ModuleNode, shape: Shape, op: OpNode): string {
  const filters = shape.fields.filter((field) => !['limit', 'cursor', 'offset', 'sort', 'page'].includes(field));
  const where = '{ ' + filters.map((field) => field + ': input.' + field).join(', ') + ' }';
  const limit = shape.fields.includes('limit') ? 'input.limit' : 'null';
  const lines = ['export async function list(input, io) {'];
  if (!shape.entity) {
    lines.push('  const scanned = await io.scan();');
    lines.push('  const items = scanned.map((item) => item.b).filter((item) => item != null);');
    if (filters.length > 0) {
      lines.push('  const filtered = items.filter((item) => ' + filters.map((field) => 'item.' + field + ' === input.' + field).join(' && ') + ');');
    }
    lines.push('  return { result: ' + (filters.length > 0 ? 'filtered' : 'items') + ' };', '}', '');
    return lines.join('\n');
  }
  lines.push('  const found = await io.find(' + quote(shape.entity) + ', { where: ' + where + ', limit: ' + limit + ' });');
  lines.push('  const items = Array.isArray(found) ? found : (found && found.items) || [];');
  const inner = unwrap(op.returns);
  const page = inner && inner.kind === 'named' ? mod.types.find((decl) => decl.name === inner.name && decl.type.kind === 'record') : undefined;
  if (page) lines.push('  return { result: { items, next: (found && found.next) || null } };');
  else lines.push('  return { result: items };');
  lines.push('}', '');
  return lines.join('\n');
}

export function referenceBodies(mod: ModuleNode, svc: ServiceNode): ReferenceBodies {
  const bodies: Record<string, string> = {};
  const gaps: ReferenceBodies['gaps'] = [];
  const entities = new Set<string>();
  for (const op of svc.contract) {
    if (op.kind !== 'op') {
      gaps.push({ op: op.name, reason: 'a job has no HTTP body to derive' });
      continue;
    }
    const shape = shapeFor(mod, op);
    if ('gap' in shape) {
      gaps.push({ op: op.name, reason: shape.gap });
      continue;
    }
    let source = '';
    if (shape.form === 'create') source = generatedCreate(mod, svc, shape, op);
    else if (shape.form === 'read') source = generatedRead(mod, svc, shape, op);
    else if (shape.form === 'update') source = generatedUpdate(shape, op);
    else if (shape.form === 'delete') source = generatedDelete(mod, shape, op);
    else source = generatedList(mod, shape, op);
    if (!source) {
      gaps.push({ op: op.name, reason: 'the contract names no error and no optional result for a missing record' });
      continue;
    }
    bodies[op.name] = source;
    if (shape.entity) entities.add(shape.entity);
  }
  return { bodies, gaps, entities: [...entities].sort() };
}
