// ClickHouse DDL for the olap capability (B95.2). The compiler owns the table
// shape: a body appends a record of a declared type and never writes DDL, so a
// column that does not exist in the model cannot appear in the store. These
// builders are pure — the adapter (B95.3) sends their output over HTTP 8123.
import type { TypeExpr } from '../ast.ts';

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

// The raw escape hatch accepts one read-only statement: a second one could
// hide a write behind a SELECT.
export function readOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+$/, '');
  if (trimmed.includes(';')) return false;
  return /^(select|with)\b/i.test(trimmed);
}
