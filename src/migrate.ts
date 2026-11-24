import { createHash } from 'node:crypto';
import type { Expr, ModuleNode, Param, ServiceNode, TypeDecl, TypeExpr } from './ast.ts';
import { MYSQL, type SqlDialect } from './dialects.ts';
import { storageUse } from './capabilities.ts';
import { canonicalInstant, isIsoInstant } from './instant.ts';

export interface Migration {
  version: string;
  name: string;
  checksum: string;
  up: string;
  down: string;
}

export interface MigrationPlan {
  service: string;
  migrations: Migration[];
}

const BUILTINS = new Set([
  'string', 'bytes', 'int', 'float', 'number', 'bool', 'boolean', 'uuid',
  'json', 'datetime', 'decimal', 'list', 'map', 'void', 'null',
  // Constrained string shorthands: same column, different contract.
  'email', 'url', 'uri',
]);

// Resolve a field type through aliases to a base category. Anything that is
// not a scalar column lands in 'json' (inline records, unions, list/map, or a
// named type we cannot resolve — the conservative, honest default).
export function baseType(mod: ModuleNode, type: TypeExpr, depth = 0): string {
  if (depth > 8) return 'json';
  switch (type.kind) {
    case 'optional':
      return baseType(mod, type.inner, depth + 1);
    case 'named': {
      if (BUILTINS.has(type.name)) return type.name;
      const decl = mod.types.find((d) => d.name === type.name);
      if (decl) return baseType(mod, decl.type, depth + 1);
      if (mod.enums.some((e) => e.name === type.name)) return 'enum';
      return 'json';
    }
    default:
      return 'json';
  }
}

export type DefaultValue = string | number | boolean | null;

// A field default is a static scalar. The DDL, the runtime insert and the
// OpenAPI schema all read the same resolved value, so one declaration cannot
// mean different things in different layers. check() rejects anything that is
// not a literal of the field's type (A059) before an emitter ever sees it.
export function defaultValue(
  mod: ModuleNode,
  type: TypeExpr,
  expr: Expr,
): { ok: true; value: DefaultValue } | { ok: false; reason: string } {
  if (expr.kind !== 'literal') return { ok: false, reason: 'default must be a literal' };
  const optional = type.kind === 'optional';
  const base = baseType(mod, type);
  const value = expr.value;
  if (value === null) {
    return optional ? { ok: true, value: null } : { ok: false, reason: 'default null needs an optional field' };
  }
  switch (base) {
    case 'string':
    case 'email':
    case 'url':
    case 'uri':
    case 'enum':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: base + ' field needs a string default' };
    case 'uuid':
      // A uuid column is CHAR(36): any string fits, so a typo would only show
      // up in clients that parse the OpenAPI default. Reject it at the model.
      if (typeof value !== 'string') return { ok: false, reason: 'uuid field needs a string default' };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return { ok: false, reason: JSON.stringify(value) + ' is not a UUID' };
      }
      return { ok: true, value };
    case 'datetime':
      // A datetime default is an instant, so it carries its zone: the same
      // rule a trigger uses. Without one, the DDL literal would depend on the
      // server's clock and `DEFAULT 'nonsense'` would only fail at migration.
      if (typeof value !== 'string') return { ok: false, reason: 'datetime field needs a string default' };
      if (!isIsoInstant(value)) {
        return { ok: false, reason: JSON.stringify(value) + ' is not an ISO-8601 instant with a time zone' };
      }
      // DATETIME(3) keeps milliseconds and the runtime field is canonical to
      // them: a finer fraction would be cut in the DDL and refused by the
      // store, so every insert relying on the default answered 400. Digits
      // past the third one only matter when one of them is not a zero:
      // `.1230` names the millisecond `.123` exactly, so it is cut to it and
      // accepted, while `.1234` names an instant no column can hold.
      const fraction = /\.(\d+)/.exec(value);
      if (fraction && /[1-9]/.test(fraction[1].slice(3))) {
        return { ok: false, reason: JSON.stringify(value) + ' is finer than a millisecond' };
      }
      // The default is published to the runtime in the same spelling a store
      // keeps, so a row that predates the field reads back the same on both.
      const canonical = canonicalInstant(value);
      if (canonical === null) return { ok: false, reason: JSON.stringify(value) + ' is not an ISO-8601 instant with a time zone' };
      return { ok: true, value: canonical };
    case 'int':
      // BIGINT has no fractional part; a DDL DEFAULT 1.5 is an error on
      // Postgres and a silent truncation on MySQL, so it is a model mistake.
      if (typeof value !== 'number') return { ok: false, reason: 'int field needs a numeric default' };
      if (!Number.isInteger(value)) return { ok: false, reason: value + ' is not a whole number' };
      return { ok: true, value };
    case 'float':
    case 'number':
    case 'decimal':
      return typeof value === 'number'
        ? { ok: true, value }
        : { ok: false, reason: base + ' field needs a numeric default' };
    case 'bool':
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, reason: base + ' field needs a true/false default' };
    default:
      return { ok: false, reason: base + ' field cannot carry a default' };
  }
}

export function fieldDefault(mod: ModuleNode, field: Param): DefaultValue | undefined {
  if (!field.default) return undefined;
  const resolved = defaultValue(mod, field.type, field.default);
  return resolved.ok ? resolved.value : undefined;
}

export interface Column {
  name: string;
  base: string;
  nullable: boolean;
  unique: boolean;
  sql: string;
  // Declared default, already resolved to a plain value: the sql runtime and
  // the generated insert path both apply it, and the DDL writes it as DEFAULT.
  default?: DefaultValue;
}

// Column metadata shared by the DDL emitter and the sql runtime codec: the
// same resolution that picks a column type decides how a value is written and
// read back, so a field can never drift between schema and runtime.
export function recordColumns(mod: ModuleNode, decl: TypeDecl, uniques: string[][], dialect: SqlDialect = MYSQL): Column[] {
  const fields = decl.type.kind === 'record' ? decl.type.fields : [];
  return fields.map((field) => {
    const base = baseType(mod, field.type);
    // A field in any unique tuple is indexed, so its string type is bounded.
    const unique = uniques.some((tuple) => tuple.includes(field.name));
    return {
      name: field.name,
      base,
      nullable: field.type.kind === 'optional',
      unique,
      sql: dialect.type(base, unique),
      default: fieldDefault(mod, field),
    };
  });
}

function columnDef(mod: ModuleNode, field: Param, unique: boolean, dialect: SqlDialect): string {
  const optional = field.type.kind === 'optional';
  const base = baseType(mod, field.type);
  let def = dialect.quote(field.name) + ' ' + dialect.type(base, unique);
  if (!optional) def += ' NOT NULL';
  const resolved = field.default ? defaultValue(mod, field.type, field.default) : null;
  if (resolved && resolved.ok) def += ' DEFAULT ' + dialect.defaultLiteral(resolved.value, base);
  return def;
}

function entityTable(
  mod: ModuleNode,
  decl: TypeDecl,
  uniques: string[][],
  indexes: string[] = [],
  dialect: SqlDialect = MYSQL,
): { up: string; down: string } {
  const fields = decl.type.kind === 'record' ? decl.type.fields : [];
  const table = decl.name.toLowerCase();
  const cols: string[] = [];
  for (const field of fields) {
    // The id column is the primary key, so a string there is bounded too: a
    // TEXT key is 1170 on MySQL ("used in key specification without a key
    // length") and a silent failed migration on every table after it.
    const indexed = field.name === 'id' || uniques.some((tuple) => tuple.includes(field.name));
    cols.push('  ' + columnDef(mod, field, indexed, dialect));
  }
  if (fields.some((f) => f.name === 'id')) cols.push('  ' + dialect.primaryKey('id'));
  for (const tuple of uniques) {
    if (tuple.length === 0) continue;
    if (!tuple.every((field) => fields.some((f) => f.name === field))) continue;
    cols.push('  ' + dialect.uniqueKey(table, tuple));
  }
  // A plain index is a query fact: find/order predicates read this column.
  // Unique fields already carry a b-tree, so they are skipped here. MySQL
  // spells it inside CREATE TABLE, Postgres as a separate statement.
  const after: string[] = [];
  for (const field of indexes) {
    if (uniques.some((tuple) => tuple.length === 1 && tuple[0] === field)) continue;
    if (!fields.some((f) => f.name === field)) continue;
    const statement = dialect.indexStatement(table, field);
    if (statement === null) continue;
    if (dialect.name === 'mysql') cols.push('  ' + statement);
    else after.push(statement);
  }
  const create =
    'CREATE TABLE IF NOT EXISTS ' + dialect.quote(table) + ' (\n' + cols.join(',\n') + '\n)' + dialect.tableSuffix;
  const up = [create, ...after.map((statement) => statement + ';')].join('\n');
  return { up, down: 'DROP TABLE IF EXISTS ' + dialect.quote(table) };
}

export function checksumOf(up: string, down: string): string {
  return createHash('sha256').update(up + '\n' + down).digest('hex');
}

function usesSql(svc: ServiceNode): boolean {
  return svc.uses.some((use) => use.capability === 'sql' || use.capability.endsWith('.sql'));
}

function usesQueue(svc: ServiceNode): boolean {
  return svc.uses.some((use) => use.capability === 'queue' || use.capability.endsWith('.queue'));
}

// A body is the only truthful evidence of what a store call targets: an
// operation's return type may be a DTO (an ack, a receipt), never a table.
const ENTITY_CALL = /\bio\.(?:insert|fetch|update|remove|find)\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g;

// Entity names a set of impl bodies actually touches, or null when there is no
// evidence at all: a scaffold build keeps the old "every record is a table"
// behaviour rather than silently dropping tables the runtime may need.
export function entitiesFromBodies(bodies: Record<string, string> | undefined, declared?: string[]): string[] | null {
  if (!bodies) return null;
  const names = new Set<string>();
  for (const body of Object.values(bodies)) {
    for (const match of body.matchAll(ENTITY_CALL)) names.add(match[2]);
  }
  // A literal that names no declared type is a typo, not evidence: it must not
  // shrink the entity set to nothing (that would hide the very list the 500
  // and the check error need to show).
  if (declared) for (const name of [...names]) {
    if (!declared.includes(name)) names.delete(name);
  }
  return names.size > 0 ? [...names].sort() : null;
}

export function migrationPlan(
  mod: ModuleNode,
  svc: ServiceNode,
  options: { dialect?: SqlDialect; entities?: string[] | null } = {},
): MigrationPlan {
  const dialect = options.dialect ?? MYSQL;
  const migrations: Migration[] = [];

  // A service with no storage capability has nothing to migrate: no kv blob,
  // no entity table, no outbox. An empty plan is the honest answer, and it
  // keeps .arcod/build/migrations from pretending otherwise.
  if (storageUse(svc) === null) return { service: svc.name, migrations };

  const uniquesByEntity: Record<string, string[][]> = {};
  const indexesByEntity: Record<string, string[]> = {};
  for (const rule of svc.rules) {
    if (rule.kind === 'unique') {
      const entity = rule.path.split('.')[0];
      (uniquesByEntity[entity] ??= []).push(rule.fields);
      continue;
    }
    if (rule.kind !== 'index') continue;
    const parts = rule.path.split('.');
    if (parts.length === 2) (indexesByEntity[parts[0]] ??= []).push(parts[1]);
  }

  // Base blob store: what the runtime uses today for kv records and unique
  // claims. First migration so a fresh DB always matches what the service
  // expects.
  const kvQ = (name: string) => dialect.quote(name);
  // The MySQL text stays byte-identical: an applied migration is checksummed,
  // and a rewrite would look like an edited migration on every existing db.
  const kvUp = dialect.name === 'mysql'
    ? 'CREATE TABLE IF NOT EXISTS arcod_kv (k VARBINARY(255) NOT NULL PRIMARY KEY, v LONGBLOB NOT NULL, expires_at BIGINT NOT NULL, KEY arcod_kv_expires (expires_at)) ENGINE=InnoDB'
    : 'CREATE TABLE IF NOT EXISTS ' + kvQ('arcod_kv') + ' (' + kvQ('k') + ' VARCHAR(255) NOT NULL PRIMARY KEY, ' + kvQ('v') + ' BYTEA NOT NULL, ' + kvQ('expires_at') + ' BIGINT NOT NULL);\nCREATE INDEX IF NOT EXISTS arcod_kv_expires ON ' + kvQ('arcod_kv') + ' (expires_at);';
  migrations.push({
    version: '0001',
    name: 'arcod_kv',
    checksum: checksumOf(kvUp, 'DROP TABLE IF EXISTS arcod_kv'),
    up: kvUp,
    down: 'DROP TABLE IF EXISTS ' + kvQ('arcod_kv'),
  });

  // DTO types are shapes the service returns, not rows it stores: only the
  // entity set (from the bodies) gets a table.
  const wanted = options.entities ?? null;
  const entities = mod.types
    .filter((d) => d.type.kind === 'record')
    .filter((d) => wanted === null || wanted.includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const decl of entities) {
    const uniques = uniquesByEntity[decl.name] ?? [];
    const indexes = indexesByEntity[decl.name] ?? [];
    const { up, down } = entityTable(mod, decl, uniques, indexes, dialect);
    migrations.push({
      version: String(migrations.length + 1).padStart(4, '0'),
      name: decl.name.toLowerCase(),
      checksum: checksumOf(up, down),
      up,
      down,
    });
  }

  // The outbox holds events an operation published together with a fact write:
  // the two commit in one transaction, and a dispatcher relays the row to the
  // real queue. Only exists on the sql driver with a queue capability.
  if (usesSql(svc) && usesQueue(svc)) {
    // MySQL spells the pending index inside the table, so the table closes
    // with a comma-terminated last column plus the KEY line. Postgres spells it
    // as its own statement and must not keep a trailing comma: joining an empty
    // placeholder produced `published_at BIGINT NULL,\n\n);`, which postgres
    // rejects (issue #43).
    const mysql = dialect.name === 'mysql';
    const lines = [
      mysql
        ? 'CREATE TABLE IF NOT EXISTS arcod_outbox ('
        : 'CREATE TABLE IF NOT EXISTS ' + dialect.quote('arcod_outbox') + ' (',
      '  id CHAR(36) NOT NULL PRIMARY KEY,',
      '  topic TEXT NOT NULL,',
      '  payload TEXT NOT NULL,',
      '  created_at BIGINT NOT NULL,',
    ];
    if (mysql) {
      lines.push('  published_at BIGINT NULL,', '  KEY arcod_outbox_pending (published_at)', ') ENGINE=InnoDB');
    } else {
      lines.push('  published_at BIGINT NULL', ');',
        'CREATE INDEX IF NOT EXISTS arcod_outbox_pending ON ' + dialect.quote('arcod_outbox') + ' (published_at);');
    }
    const up = lines.join('\n');
    migrations.push({
      version: String(migrations.length + 1).padStart(4, '0'),
      name: 'arcod_outbox',
      checksum: checksumOf(up, 'DROP TABLE IF EXISTS arcod_outbox'),
      up,
      down: 'DROP TABLE IF EXISTS ' + dialect.quote('arcod_outbox'),
    });
  }

  return { service: svc.name, migrations };
}

export function formatMigrations(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push('migrations for ' + plan.service + ' (' + plan.migrations.length + '):');
  for (const m of plan.migrations) {
    lines.push('  ' + m.version + ' ' + m.name + '  checksum ' + m.checksum.slice(0, 12));
    lines.push('    up:   ' + m.up.split('\n')[0]);
    lines.push('    down: ' + m.down);
  }
  return lines.join('\n');
}
