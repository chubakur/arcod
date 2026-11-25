// SQL dialects. The compiler owns the shape of the data model; the dialect
// owns how that shape is spelled in a particular database. Keeping the two
// apart is what lets the same spec produce MySQL DDL today and Postgres DDL
// without forking migration.ts.
//
// v0.1 ships MySQL as the runtime dialect (the bundled wire client speaks its
// protocol) and Postgres as a DDL target: the plan is generated and testable,
// the runtime adapter is the next step (B5.2).

import { utcDateTime } from './instant.ts';

export type DialectName = 'mysql' | 'postgres';

export interface SqlDialect {
  name: DialectName;
  quote(identifier: string): string;
  // Column type for a resolved base type. Unique strings are bounded because
  // an index needs a fixed-width key.
  type(base: string, unique: boolean): string;
  // `base` is the column's resolved type: a datetime default needs a
  // dialect-specific spelling, every other scalar is a plain literal.
  defaultLiteral(value: string | number | boolean | null, base: string): string;
  tableSuffix: string;
  migrationsTable: string;
  primaryKey(field: string): string;
  // One or more columns: a tuple key enforces the pair, a single key names
  // uq_<table>_<field> exactly as before.
  uniqueKey(table: string, fields: string[]): string;
  // Returns a statement to append after CREATE TABLE, or null when the
  // dialect spells an index inside the table body.
  indexStatement(table: string, field: string): string | null;
}

const MYSQL_TYPES: Record<string, string> = {
  int: 'BIGINT',
  float: 'DOUBLE',
  number: 'DOUBLE',
  decimal: 'DECIMAL(30,6)',
  bool: 'TINYINT(1)',
  boolean: 'TINYINT(1)',
  uuid: 'CHAR(36)',
  datetime: 'DATETIME(3)',
  bytes: 'LONGBLOB',
  enum: 'VARCHAR(64)',
};

const POSTGRES_TYPES: Record<string, string> = {
  int: 'BIGINT',
  float: 'DOUBLE PRECISION',
  number: 'DOUBLE PRECISION',
  decimal: 'NUMERIC(30,6)',
  bool: 'BOOLEAN',
  boolean: 'BOOLEAN',
  uuid: 'UUID',
  datetime: 'TIMESTAMPTZ',
  bytes: 'BYTEA',
  enum: 'VARCHAR(64)',
};

function quoteWith(open: string, close: string): (name: string) => string {
  return (name: string) => open + String(name).split(close).join(close + close) + close;
}

function stringDefault(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export const MYSQL: SqlDialect = {
  name: 'mysql',
  quote: quoteWith('`', '`'),
  type(base, unique) {
    if (base === 'string' || base === 'email' || base === 'url' || base === 'uri') return unique ? 'VARCHAR(191)' : 'TEXT';
    // hasOwn first: a field whose type is an undeclared name like `toString`
    // would otherwise answer a function, and that source text would become the
    // column type in the DDL.
    return Object.hasOwn(MYSQL_TYPES, base) ? MYSQL_TYPES[base] : 'JSON';
  },
  defaultLiteral(value, base) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return String(value);
    // MySQL's DATETIME literal has no zone: `DEFAULT '2026-01-01T00:00:00Z'`
    // is error 1067 at migration time. Write the same instant in UTC.
    if (base === 'datetime') {
      const utc = utcDateTime(value);
      if (utc) return stringDefault(utc);
    }
    return stringDefault(value);
  },
  tableSuffix: ' ENGINE=InnoDB',
  migrationsTable:
    'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL) ENGINE=InnoDB',
  primaryKey: (field) => 'PRIMARY KEY (' + MYSQL.quote(field) + ')',
  uniqueKey: (table, fields) => 'UNIQUE KEY ' + MYSQL.quote('uq_' + table + '_' + fields.join('_')) + ' (' + fields.map((field) => MYSQL.quote(field)).join(', ') + ')',
  indexStatement: (table, field) =>
    'KEY ' + MYSQL.quote('idx_' + table + '_' + field) + ' (' + MYSQL.quote(field) + ')',
};

export const POSTGRES: SqlDialect = {
  name: 'postgres',
  quote: quoteWith('"', '"'),
  type(base, unique) {
    if (base === 'string' || base === 'email' || base === 'url' || base === 'uri') return unique ? 'VARCHAR(191)' : 'TEXT';
    return Object.hasOwn(POSTGRES_TYPES, base) ? POSTGRES_TYPES[base] : 'JSONB';
  },
  defaultLiteral(value, base) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    // TIMESTAMPTZ accepts the ISO instant as written, zone included.
    if (base === 'datetime') return stringDefault(value) + '::timestamptz';
    return stringDefault(value);
  },
  tableSuffix: '',
  migrationsTable:
    'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL)',
  primaryKey: (field) => 'PRIMARY KEY (' + POSTGRES.quote(field) + ')',
  uniqueKey: (table, fields) => 'CONSTRAINT ' + POSTGRES.quote('uq_' + table + '_' + fields.join('_')) + ' UNIQUE (' + fields.map((field) => POSTGRES.quote(field)).join(', ') + ')',
  // Postgres indexes are their own statements; CREATE TABLE has no KEY clause.
  indexStatement: (table, field) =>
    'CREATE INDEX IF NOT EXISTS ' + POSTGRES.quote('idx_' + table + '_' + field) + ' ON ' + POSTGRES.quote(table) + ' (' + POSTGRES.quote(field) + ')',
};

export const DIALECTS: Record<DialectName, SqlDialect> = { mysql: MYSQL, postgres: POSTGRES };

export function dialectNamed(name: string | undefined): SqlDialect {
  if (!name || name === 'mysql') return MYSQL;
  if (name === 'postgres' || name === 'postgresql') return POSTGRES;
  throw new Error('unknown sql dialect ' + name + ' (mysql, postgres)');
}
