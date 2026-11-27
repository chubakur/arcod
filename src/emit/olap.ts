// ClickHouse DDL for the olap capability (B95.2). The compiler owns the table
// shape: a body appends a record of a declared type and never writes DDL, so a
// column that does not exist in the model cannot appear in the store. These
// builders are pure — the adapter (B95.3) sends their output over HTTP 8123.
import type { Expr, TypeDecl, TypeExpr } from '../ast.ts';

export interface OlapColumn {
  name: string;
  type: string;
}

export interface OlapTable {
  name: string;
  columns: OlapColumn[];
  orderBy: string[];
  ttl?: string;
}

// The scalar vocabulary of the model, spelled the way ClickHouse stores it.
// A type outside this table is refused by name instead of being guessed into
// String: a silent string column turns every later sum into zero.
const SCALARS: Record<string, string> = {
  int: 'Int64',
  number: 'Float64',
  float: 'Float64',
  decimal: 'Decimal(30, 6)',
  datetime: 'DateTime64(3)',
  bool: 'UInt8',
  boolean: 'UInt8',
  string: 'String',
  uuid: 'String',
  url: 'String',
  email: 'String',
  json: 'String',
};

export function clickhouseType(type: TypeExpr, named: Map<string, TypeExpr>): string | null {
  if (type.kind === 'optional') {
    const inner = clickhouseType(type.inner, named);
    return inner === null ? null : 'Nullable(' + inner + ')';
  }
  if (type.kind !== 'named') return null;
  const base = type.name;
  // optional<T> parses as a named type with the inner type as its argument,
  // not as the `optional` kind: without this branch the field was reported as
  // having no ClickHouse type and the record lost its nullable column (B95.3).
  if (base === 'optional') {
    const arg = type.args.find((item) => item.isType);
    if (!arg) return null;
    const inner = clickhouseType(arg.value as TypeExpr, named);
    return inner === null ? null : 'Nullable(' + inner + ')';
  }
  if (base === 'list') {
    const arg = type.args.find((item) => item.isType);
    if (!arg) return null;
    const inner = clickhouseType(arg.value as TypeExpr, named);
    return inner === null ? null : 'Array(' + inner + ')';
  }
  const decl = named.get(base);
  if (decl && decl.kind === 'optional') return clickhouseType(decl, named);
  if (decl && decl.kind === 'named') return clickhouseType(decl, named);
  return Object.hasOwn(SCALARS, base) ? SCALARS[base] : null;
}

// One column per record field, in declaration order: the order is what a
// FORMAT JSONEachRow insert and a positional SELECT rely on being stable.
export function olapColumns(fields: Array<{ name: string; type: TypeExpr }>, named: Map<string, TypeExpr>): { columns: OlapColumn[]; problems: string[] } {
  const columns: OlapColumn[] = [];
  const problems: string[] = [];
  for (const field of fields) {
    const type = clickhouseType(field.type, named);
    if (type === null) {
      problems.push('column ' + field.name + ' has no ClickHouse type');
      continue;
    }
    columns.push({ name: field.name, type });
  }
  return { columns, problems };
}

function quoteName(name: string): string {
  return '"' + name.replace(/"/g, '') + '"';
}

// CREATE TABLE IF NOT EXISTS keeps the migrate step idempotent, and MergeTree
// needs an ORDER BY: the capability's orderBy is the sorting key, and a table
// without one falls back to tuple() — legal, but a full scan on every query.
export function createTableSql(table: OlapTable): string {
  const columns = table.columns.map((column) => quoteName(column.name) + ' ' + column.type);
  if (table.ttl) {
    // ClickHouse spells a TTL on the column it expires by: TTL toDateTime(at).
    columns.push('TTL toDateTime(' + quoteName(table.ttl) + ')');
  }
  const order = table.orderBy.length > 0 ? table.orderBy.map(quoteName).join(', ') : 'tuple()';
  return 'CREATE TABLE IF NOT EXISTS ' + quoteName(table.name) + ' (' + columns.join(', ') + ')\n'
    + 'ENGINE = MergeTree\n'
    + 'ORDER BY (' + order + ')';
}

// A typed append: the adapter posts one JSON object per line under this
// prefix, so a retried job writes the same row twice (at-least-once) and a
// count that must not inflate asks for distinct.
export function insertSql(table: string): string {
  return 'INSERT INTO ' + quoteName(table) + ' FORMAT JSONEachRow';
}

export interface OlapQuery {
  where?: Record<string, unknown>;
  groupBy?: string[];
  metrics?: Array<{ name: string; op: string; field?: string; distinct?: boolean }>;
  order?: string;
  limit?: number;
}

const METRICS = new Set(['sum', 'count', 'avg', 'min', 'max']);
const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'ne', 'in', 'contains']);

// A typed select is the main path: the body names columns, not SQL. Every
// identifier is checked against the declared table (an unknown column is an
// error with its name, not a ClickHouse 400 after the query), and every value
// travels as a {pN:Type} parameter — a string that looks like SQL stays a
// string, which is what makes the raw escape hatch unnecessary for filters.
export function selectSql(
  table: string,
  columns: OlapColumn[],
  query: OlapQuery,
): { sql: string; params: Record<string, string> } {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const params: Record<string, string> = {};
  let counter = 0;
  const columnOf = (name: string): OlapColumn => {
    const column = byName.get(name);
    if (!column) throw new Error('unknown column ' + name + '; declared: ' + columns.map((item) => item.name).join(', '));
    return column;
  };
  const param = (value: unknown, type: string): string => {
    counter += 1;
    const key = 'p' + counter;
    params[key] = String(value);
    return '{' + key + ':' + type + '}';
  };

  const conditions: string[] = [];
  for (const [name, raw] of Object.entries(query.where ?? {})) {
    const column = columnOf(name);
    const ref = '"' + column.name + '"';
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [operator, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!OPERATORS.has(operator)) throw new Error('unknown operator ' + operator + ' on column ' + name);
        if (operator === 'in') {
          const list = Array.isArray(value) ? value : [value];
          if (list.length === 0) {
            conditions.push('0');
            continue;
          }
          conditions.push(ref + ' IN (' + list.map((item) => param(item, column.type)).join(', ') + ')');
          continue;
        }
        if (operator === 'contains') {
          conditions.push('position(' + ref + ', ' + param(value, column.type) + ') > 0');
          continue;
        }
        const symbol: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '!=' };
        conditions.push(ref + ' ' + symbol[operator] + ' ' + param(value, column.type));
      }
      continue;
    }
    if (raw === null) {
      conditions.push(ref + ' IS NULL');
      continue;
    }
    conditions.push(ref + ' = ' + param(raw, column.type));
  }

  const group = (query.groupBy ?? []).map((name) => {
    const column = columnOf(name);
    return { name: column.name, ref: '"' + column.name + '"' };
  });
  const metrics = (query.metrics ?? []).map((metric) => {
    const op = metric.op.toLowerCase();
    if (!METRICS.has(op)) throw new Error('unknown metric ' + metric.op + '; use sum, count, avg, min or max');
    if (op === 'count' && (!metric.field || metric.distinct)) {
      const field = metric.distinct ? columnOf(metric.field ?? '').name : null;
      return 'count(' + (field ? 'DISTINCT "' + field + '"' : '*') + ') AS "' + (metric.name || 'count') + '"';
    }
    const field = columnOf(metric.field ?? metric.name);
    return op + '("' + field.name + '") AS "' + (metric.name || op) + '"';
  });

  const list = [...group.map((item) => item.ref), ...metrics];
  const sql = ['SELECT ' + (list.length > 0 ? list.join(', ') : '*'), 'FROM "' + table + '"'];
  if (conditions.length > 0) sql.push('WHERE ' + conditions.join(' AND '));
  if (group.length > 0) sql.push('GROUP BY ' + group.map((item) => item.ref).join(', '));
  if (query.order) {
    const parts = query.order.trim().split(/\s+/);
    const column = columnOf(parts[0]);
    const direction = (parts[1] ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    sql.push('ORDER BY "' + column.name + '" ' + direction);
  }
  if (query.limit !== undefined) {
    const limit = Math.trunc(Number(query.limit));
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive whole number');
    sql.push('LIMIT ' + limit);
  }
  sql.push('FORMAT JSON');
  return { sql: sql.join('\n'), params };
}

// The raw escape hatch accepts one read-only statement: a second one could
// hide a write behind a SELECT.
export function readOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+$/, '');
  if (trimmed.includes(';')) return false;
  return /^(select|with)\b/i.test(trimmed);
}

// B95.3: the tables a service with the olap capability carries. Every record
// type of the module is a candidate table — the adapter keeps the map and
// refuses an entity it does not find, so a body cannot write into a shape the
// compiler never saw. orderBy and ttl come from the capability clause: the key
// is shared by the tables (a column name that one record lacks is reported,
// not silently dropped), and the TTL column is the record's datetime field.
export function olapTablesFromTypes(
  types: TypeDecl[],
  options: { orderBy?: string[]; ttl?: boolean } = {},
): { tables: OlapTable[]; problems: string[] } {
  const named = new Map(types.map((decl) => [decl.name, decl.type]));
  const tables: OlapTable[] = [];
  const problems: string[] = [];
  for (const decl of types) {
    if (decl.type.kind !== 'record') continue;
    const { columns, problems: columnProblems } = olapColumns(decl.type.fields, named);
    for (const problem of columnProblems) problems.push(decl.name + ': ' + problem);
    if (columns.length === 0) continue;
    const orderBy: string[] = [];
    for (const name of options.orderBy ?? []) {
      if (!columns.some((column) => column.name === name)) {
        problems.push(decl.name + ': orderBy names ' + name + ', which the record does not have');
        continue;
      }
      orderBy.push(name);
    }
    const table: OlapTable = { name: decl.name, columns, orderBy };
    if (options.ttl) {
      const dated = columns.find((column) => column.type.startsWith('DateTime64'));
      if (!dated) problems.push(decl.name + ': ttl needs a datetime column and the record has none');
      else table.ttl = dated.name;
    }
    tables.push(table);
  }
  return { tables, problems };
}

// The use clause carries the physical shape: orderBy names the sorting key,
// ttl asks for expiry by the record's datetime column. One reader for emitService
// and the build, so the DDL and the adapter cannot disagree about a table.
export function olapUseOptions(params: Record<string, Expr>): { orderBy?: string[]; ttl?: boolean } {
  const orderBy = params.orderBy;
  const order = orderBy && orderBy.kind === 'literal' && typeof orderBy.value === 'string' ? [orderBy.value] : undefined;
  return { orderBy: order, ttl: Boolean(params.ttl) };
}
