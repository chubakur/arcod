// Capability signatures are the only library knowledge a body-generation
// prompt needs. The compiler never asks the model to pick a package: the
// model names an effect, the environment binds a provider.
//
// Signatures are written in terms of ids, not storage keys: key layout,
// prefixes and TTL are the adapter's business, not the body's.
import type { ServiceNode } from './ast.ts';
export interface CapabilitySpec {
  effects: Record<string, string>;
  short: Record<string, string>;
  notes?: string;
}

export const CAPABILITIES: Record<string, CapabilitySpec> = {
  kv: {
    effects: {
      get: 'load(id: string) -> { b: string, h: string | null } | null',
      set: 'save(id: string, record: { b: string, h: string | null }) -> void',
      del: 'del(id: string) -> void',
      has: 'has(id: string) -> boolean',
      takeIf: 'takeIf(id: string, record) -> boolean',
      seen: 'seen(id: string) -> boolean',
    },
    short: {
      get: 'load(id) -> {b,h}|null',
      set: 'save(id, {b,h})',
      del: 'del(id)',
      has: 'has(id) -> bool',
      takeIf: 'takeIf(id, record) -> bool',
      seen: 'seen(id) -> bool',
    },
    notes: 'has tells whether the message still exists; seen tells whether it was already consumed. takeIf deletes only when the stored value equals expected.',
  },
  identity: {
    effects: {
      actor: 'actor() -> { id: string, name: string, admin: boolean } | null',
      users: 'users() -> list<{ id: string, name: string }>',
    },
    short: {
      actor: 'actor() -> {id,name,admin}|null',
      users: 'users() -> list<{id,name}>',
    },
    notes: 'Tokens are verified against the provider JWKS; roles come from the token.',
  },
  blob: {
    effects: {
      put: 'blobPut(key: string, value: string, type: string?) -> void',
      get: 'blobGet(key: string) -> string | null',
      del: 'blobDelete(key: string) -> void',
    },
    short: {
      put: 'blobPut(key, value)',
      get: 'blobGet(key) -> string|null',
      del: 'blobDelete(key)',
    },
    notes: 'Objects, not rows. The adapter owns bucket and naming.',
  },
  // Same record contract as kv, different provider: the body cannot tell
  // whether the row lives in Redis or MySQL.
  sql: {
    effects: {
      get: 'load(id: string) -> { b: string, h: string | null } | null',
      set: 'save(id: string, record: { b: string, h: string | null }) -> void',
      del: 'del(id: string) -> void',
      has: 'has(id: string) -> boolean',
      takeIf: 'takeIf(id: string, record) -> boolean',
      seen: 'seen(id: string) -> boolean',
    },
    short: {
      get: 'load(id) -> {b,h}|null',
      set: 'save(id, {b,h})',
      del: 'del(id)',
      has: 'has(id) -> bool',
      takeIf: 'takeIf(id, record) -> bool',
      seen: 'seen(id) -> bool',
    },
    notes: 'Rows, not keys. The adapter owns the table and TTL.',
  },
  ids: {
    effects: {
      new: 'new() -> string',
    },
    short: { new: 'new() -> id' },
    notes: 'Returns a v4 uuid.',
  },
  hash: {
    effects: {
      hash: 'hash(password: string) -> string',
      verify: 'verify(password: string, hash: string) -> boolean',
    },
    short: { hash: 'hash(password)', verify: 'verify(password, hash) -> bool' },
    notes: 'hash returns a salted scrypt record; verify compares in constant time.',
  },
};

export function capabilityFor(name: string): CapabilitySpec | null {
  const key = name.includes('.') ? name.split('.').pop()! : name;
  return CAPABILITIES[key] ?? null;
}

// The model names a capability, never a provider. kv and sql expose the same
// record contract, so bodies do not change when the environment swaps Redis
// for MySQL.
export function storageKind(svc: ServiceNode): 'kv' | 'sql' | null {
  for (const use of svc.uses) {
    if (use.capability === 'kv' || use.capability.endsWith('.kv')) return 'kv';
    if (use.capability === 'sql' || use.capability.endsWith('.sql')) return 'sql';
  }
  return null;
}

export function storageUse(svc: ServiceNode) {
  return svc.uses.find((use) => use.capability === 'kv' || use.capability.endsWith('.kv')
    || use.capability === 'sql' || use.capability.endsWith('.sql')) ?? null;
}

export function signatureFor(alias: string, op: string): string | null {
  const spec = capabilityFor(alias);
  return spec?.effects[op] ?? null;
}

export function shortFor(alias: string, op: string): string | null {
  const spec = capabilityFor(alias);
  return spec?.short[op] ?? spec?.effects[op] ?? null;
}
