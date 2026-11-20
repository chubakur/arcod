// Constrained scalars. A type can say more than "string": `email`, `url` or a
// declared `enum`. That one declaration has to reach every layer — the OpenAPI
// schema (format/enum), the service boundary (400 instead of a 500 from a body
// that trusted the client) and check() (a default that violates the constraint).
// This module is the single resolver they all read.

import type { ModuleNode, Param, TypeExpr } from './ast.ts';

export type Format = 'email' | 'uri';

export interface Constraint {
  format: Format | null;
  enumValues: string[] | null;
}

export const EMPTY_CONSTRAINT: Constraint = { format: null, enumValues: null };

// `email` and `url` are shorthands for `string(format: email)` and
// `string(format: uri)`. Both spellings mean the same thing everywhere.
export const FORMAT_BUILTINS: Record<string, Format> = {
  email: 'email',
  url: 'uri',
  uri: 'uri',
};

export const KNOWN_FORMATS = new Set(['email', 'url', 'uri']);

export function isFormatBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FORMAT_BUILTINS, name);
}

export function isEmpty(constraint: Constraint): boolean {
  return constraint.format === null && constraint.enumValues === null;
}

function formatArgOf(args: { name?: string; value: { kind: string; name?: string } }[]): string | null {
  for (const arg of args) {
    if (arg.name !== 'format') continue;
    if (arg.value.kind === 'ident' && typeof arg.value.name === 'string') return arg.value.name;
    return '';
  }
  return null;
}

// Resolve aliases, optionals and unions down to the constraint they carry.
// A union of constrained alternatives is not itself constrained: the caller
// has to pick a variant, and v0.1 does not guess.
export function constraintOf(mod: ModuleNode, type: TypeExpr, depth = 0): Constraint {
  if (depth > 8) return EMPTY_CONSTRAINT;
  switch (type.kind) {
    case 'optional':
      return constraintOf(mod, type.inner, depth + 1);
    case 'union':
      return EMPTY_CONSTRAINT;
    case 'record':
      return EMPTY_CONSTRAINT;
    case 'named': {
      const shorthand = FORMAT_BUILTINS[type.name];
      if (shorthand) return { format: shorthand, enumValues: null };
      if (type.name === 'string') {
        const format = formatArgOf(type.args as { name?: string; value: { kind: string; name?: string } }[]);
        if (format && FORMAT_BUILTINS[format]) return { format: FORMAT_BUILTINS[format], enumValues: null };
        return EMPTY_CONSTRAINT;
      }
      const decl = mod.types.find((item) => item.name === type.name);
      if (decl) {
        const inner = constraintOf(mod, decl.type, depth + 1);
        if (!isEmpty(inner)) return inner;
        return EMPTY_CONSTRAINT;
      }
      const en = mod.enums.find((item) => item.name === type.name);
      if (en) return { format: null, enumValues: en.values.slice() };
      return EMPTY_CONSTRAINT;
    }
    default:
      return EMPTY_CONSTRAINT;
  }
}

// Unknown `format:` names are a model error, never silently ignored.
export function unknownFormatOf(type: TypeExpr): string | null {
  if (type.kind === 'optional') return unknownFormatOf(type.inner);
  if (type.kind !== 'named' || type.name !== 'string') return null;
  const format = formatArgOf(type.args as { name?: string; value: { kind: string; name?: string } }[]);
  if (format === null || format === '') return format === '' ? '' : null;
  return KNOWN_FORMATS.has(format) ? null : format;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The runtime rule, shared by the emitter (which inlines the same expressions
// into the generated service) and the tests. It returns the violated field
// description or null; a missing value is handled by required-ness, not here.
export function describeViolation(constraint: Constraint, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (constraint.enumValues) {
    const allowed = constraint.enumValues;
    if (!allowed.includes(String(value))) return 'must be one of ' + allowed.join(', ');
    return null;
  }
  if (constraint.format === 'email') {
    if (typeof value !== 'string' || !EMAIL.test(value)) return 'must be an email';
    return null;
  }
  if (constraint.format === 'uri') {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(value)) return 'must be a url';
    return null;
  }
  return null;
}

export interface Bounds {
  min: number | null;
  max: number | null;
  // A bound says which values are legal; the type says which of them fit.
  // `int(min: 1)` rejects 1.5 because an integer bound bounds integers, while
  // `number(min: 0.5)` keeps fractional values and only rejects the ones below.
  integer: boolean;
}

// Bounds are contract facts too: adopt keeps `minimum`/`maximum` from an
// OpenAPI document as `int(min:, max:)` or `number(min:, max:)`, so the schema
// and the runtime have to read the same two arguments. Only literal numbers
// count; anything else is A087 at check time.
export function boundsOf(mod: ModuleNode, type: TypeExpr, depth = 0): Bounds {
  const none: Bounds = { min: null, max: null, integer: false };
  if (depth > 8) return none;
  if (type.kind === 'optional') return boundsOf(mod, type.inner, depth + 1);
  if (type.kind !== 'named') return none;
  if (type.name === 'int' || type.name === 'number' || type.name === 'float') {
    let min: number | null = null;
    let max: number | null = null;
    for (const arg of type.args) {
      if (arg.value.kind !== 'literal' || typeof arg.value.value !== 'number') continue;
      if (arg.name === 'min') min = arg.value.value;
      if (arg.name === 'max') max = arg.value.value;
    }
    return { min, max, integer: type.name === 'int' };
  }
  const decl = mod.types.find((item) => item.name === type.name);
  return decl ? boundsOf(mod, decl.type, depth + 1) : none;
}

export function paramConstraint(mod: ModuleNode, param: Param): Constraint {
  return constraintOf(mod, param.type);
}

// Per-operation table for the generated service: only constrained parameters
// are listed, so an unconstrained service pays nothing at runtime.
export function constraintTable(
  mod: ModuleNode,
  params: Param[],
): Record<string, { format?: Format; enum?: string[]; min?: number; max?: number; integer?: boolean }> {
  const table: Record<string, { format?: Format; enum?: string[]; min?: number; max?: number; integer?: boolean }> = {};
  for (const param of params) {
    const constraint = paramConstraint(mod, param);
    if (constraint.format) table[param.name] = { format: constraint.format };
    else if (constraint.enumValues) table[param.name] = { enum: constraint.enumValues };
    const bounds = boundsOf(mod, param.type);
    if (bounds.min !== null || bounds.max !== null) {
      table[param.name] = {
        ...(table[param.name] ?? {}),
        ...(bounds.integer ? { integer: true } : {}),
        ...(bounds.min !== null ? { min: bounds.min } : {}),
        ...(bounds.max !== null ? { max: bounds.max } : {}),
      };
    }
  }
  return table;
}
