// Capability signatures are the only library knowledge a body-generation
// prompt needs. The compiler never asks the model to pick a package: the
// model names an effect, the environment binds a provider.
//
// Signatures are written in terms of ids, not storage keys: key layout,
// prefixes and TTL are the adapter's business, not the body's.
export interface CapabilitySpec {
  effects: Record<string, string>;
  notes?: string;
}

export const CAPABILITIES: Record<string, CapabilitySpec> = {
  kv: {
    effects: {
      get: 'get(id: string) -> string | null',
      set: 'set(id: string, value: string) -> void',
      del: 'del(id: string) -> void',
      has: 'has(id: string) -> boolean',
      takeIf: 'takeIf(id: string, expected: string) -> boolean',
      seen: 'seen(id: string) -> boolean',
    },
    notes: 'has tells whether the message still exists; seen tells whether it was already consumed. takeIf deletes only when the stored value equals expected.',
  },
  ids: {
    effects: {
      new: 'new() -> string',
    },
    notes: 'Returns a v4 uuid.',
  },
  hash: {
    effects: {
      hash: 'hash(password: string) -> string',
      verify: 'verify(password: string, hash: string) -> boolean',
    },
    notes: 'hash returns a salted scrypt record; verify compares in constant time.',
  },
};

export function capabilityFor(name: string): CapabilitySpec | null {
  const key = name.includes('.') ? name.split('.').pop()! : name;
  return CAPABILITIES[key] ?? null;
}

export function signatureFor(alias: string, op: string): string | null {
  const spec = capabilityFor(alias);
  return spec?.effects[op] ?? null;
}
