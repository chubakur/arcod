// SQL dialects. The compiler owns the shape of the data model; the dialect
// owns how that shape is spelled in a particular database. Keeping the two
// apart is what lets the same spec produce MySQL DDL today and Postgres DDL
// without forking migration.ts.
//
// v0.1 ships MySQL as the runtime dialect (the bundled wire client speaks its
// protocol) and Postgres as a DDL target: the plan is generated and testable,
// the runtime adapter is the next step (B5.2).

export type DialectName = 'mysql' | 'postgres';

export interface SqlDialect {
  name: DialectName;
  quote(identifier: string): string;
  // Column type for a resolved base type. Unique strings are bounded because
  // an index needs a fixed-width key.
  type(base: string, unique: boolean): string;
  defaultLiteral(value: string | number | boolean | null): string;
  tableSuffix: string;
  migrationsTable: string;
  primaryKey(field: string): string;
  uniqueKey(table: string, field: string): string;
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
    return MYSQL_TYPES[base] ?? 'JSON';
  },
  defaultLiteral(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return String(value);
    return stringDefault(value);
  },
  tableSuffix: ' ENGINE=InnoDB',
  migrationsTable:
    'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL) ENGINE=InnoDB',
  primaryKey: (field) => 'PRIMARY KEY (' + MYSQL.quote(field) + ')',
  uniqueKey: (table, field) => 'UNIQUE KEY ' + MYSQL.quote('uq_' + table + '_' + field) + ' (' + MYSQL.quote(field) + ')',
  indexStatement: (table, field) =>
    'KEY ' + MYSQL.quote('idx_' + table + '_' + field) + ' (' + MYSQL.quote(field) + ')',
};

export const POSTGRES: SqlDialect = {
  name: 'postgres',
  quote: quoteWith('"', '"'),
  type(base, unique) {
    if (base === 'string' || base === 'email' || base === 'url' || base === 'uri') return unique ? 'VARCHAR(191)' : 'TEXT';
    return POSTGRES_TYPES[base] ?? 'JSONB';
  },
  defaultLiteral(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    return stringDefault(value);
  },
  tableSuffix: '',
  migrationsTable:
    'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL)',
  primaryKey: (field) => 'PRIMARY KEY (' + POSTGRES.quote(field) + ')',
  uniqueKey: (table, field) => 'CONSTRAINT ' + POSTGRES.quote('uq_' + table + '_' + field) + ' UNIQUE (' + POSTGRES.quote(field) + ')',
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
