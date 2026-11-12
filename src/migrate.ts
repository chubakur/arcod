import { createHash } from 'node:crypto';
import type { ModuleNode, ServiceNode, TypeDecl, TypeExpr } from './ast.ts';

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
]);

// Resolve a field type through aliases to a base category. Anything that is
// not a scalar column lands in 'json' (inline records, unions, list/map, or a
// named type we cannot resolve — the conservative, honest default).
function baseType(mod: ModuleNode, type: TypeExpr, depth = 0): string {
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

function sqlTypeOf(base: string, unique: boolean): string {
  switch (base) {
    case 'int': return 'BIGINT';
    case 'float':
    case 'number': return 'DOUBLE';
    case 'decimal': return 'DECIMAL(30,6)';
    case 'bool':
    case 'boolean': return 'TINYINT(1)';
    case 'uuid': return 'CHAR(36)';
    case 'datetime': return 'DATETIME(3)';
    case 'bytes': return 'LONGBLOB';
    case 'enum': return 'VARCHAR(64)';
    case 'string': return unique ? 'VARCHAR(191)' : 'TEXT';
    default: return 'JSON';
  }
}

export interface Column {
  name: string;
  base: string;
  nullable: boolean;
  unique: boolean;
  sql: string;
}

// Column metadata shared by the DDL emitter and the sql runtime codec: the
// same resolution that picks a column type decides how a value is written and
// read back, so a field can never drift between schema and runtime.
export function recordColumns(mod: ModuleNode, decl: TypeDecl, uniques: string[]): Column[] {
  const fields = decl.type.kind === 'record' ? decl.type.fields : [];
  return fields.map((field) => {
    const base = baseType(mod, field.type);
    const unique = uniques.includes(field.name);
    return {
      name: field.name,
      base,
      nullable: field.type.kind === 'optional',
      unique,
      sql: sqlTypeOf(base, unique),
    };
  });
}

function columnDef(mod: ModuleNode, name: string, type: TypeExpr, unique: boolean): string {
  const optional = type.kind === 'optional';
  const base = baseType(mod, type);
  let def = '`' + name + '` ' + sqlTypeOf(base, unique);
  if (!optional) def += ' NOT NULL';
  return def;
}

function entityTable(mod: ModuleNode, decl: TypeDecl, uniques: string[]): { up: string; down: string } {
  const fields = decl.type.kind === 'record' ? decl.type.fields : [];
  const table = decl.name.toLowerCase();
  const cols: string[] = [];
  for (const field of fields) {
    cols.push('  ' + columnDef(mod, field.name, field.type, uniques.includes(field.name)));
  }
  if (fields.some((f) => f.name === 'id')) cols.push('  PRIMARY KEY (`id`)');
  for (const field of uniques) {
    if (!fields.some((f) => f.name === field)) continue;
    cols.push('  UNIQUE KEY `uq_' + table + '_' + field + '` (`' + field + '`)');
  }
  const up = 'CREATE TABLE IF NOT EXISTS `' + table + '` (\n' + cols.join(',\n') + '\n) ENGINE=InnoDB';
  return { up, down: 'DROP TABLE IF EXISTS `' + table + '`' };
}

export function checksumOf(up: string, down: string): string {
  return createHash('sha256').update(up + '\n' + down).digest('hex');
}

export function migrationPlan(mod: ModuleNode, svc: ServiceNode): MigrationPlan {
  const migrations: Migration[] = [];

  const uniquesByEntity: Record<string, string[]> = {};
  for (const rule of svc.rules) {
    if (rule.kind !== 'unique') continue;
    const parts = rule.path.split('.');
    if (parts.length === 2) {
      (uniquesByEntity[parts[0]] ??= []).push(parts[1]);
    }
  }

  // Base blob store: what the runtime uses today for kv records and unique
  // claims. First migration so a fresh DB always matches what the service
  // expects.
  const kvUp = 'CREATE TABLE IF NOT EXISTS arcod_kv (k VARBINARY(255) NOT NULL PRIMARY KEY, v LONGBLOB NOT NULL, expires_at BIGINT NOT NULL, KEY arcod_kv_expires (expires_at)) ENGINE=InnoDB';
  migrations.push({
    version: '0001',
    name: 'arcod_kv',
    checksum: checksumOf(kvUp, 'DROP TABLE IF EXISTS arcod_kv'),
    up: kvUp,
    down: 'DROP TABLE IF EXISTS arcod_kv',
  });

  const entities = mod.types.filter((d) => d.type.kind === 'record').sort((a, b) => a.name.localeCompare(b.name));
  for (const decl of entities) {
    const uniques = uniquesByEntity[decl.name] ?? [];
    const { up, down } = entityTable(mod, decl, uniques);
    migrations.push({
      version: String(migrations.length + 1).padStart(4, '0'),
      name: decl.name.toLowerCase(),
      checksum: checksumOf(up, down),
      up,
      down,
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
