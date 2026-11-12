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
      scan: 'scan() -> list<{ id: string, b: any }>',
      insert: 'insert(entity: string, record: any) -> any',
      fetch: 'fetch(entity: string, id: string) -> any | null',
      update: 'update(entity: string, id: string, patch: any) -> any',
      remove: 'remove(entity: string, id: string) -> bool',
      find: 'find(entity: string, query: { where?: any, order?: string, limit?: int, cursor?: string }) -> { items: list<any>, next: string | null }',
    },
    short: {
      get: 'load(id) -> {b,h}|null',
      set: 'save(id, {b,h})',
      del: 'del(id)',
      has: 'has(id) -> bool',
      takeIf: 'takeIf(id, record) -> bool',
      seen: 'seen(id) -> bool',
      scan: 'scan() -> list<{id,b}>',
      insert: 'insert(entity, record)',
      fetch: 'fetch(entity, id) -> record|null',
      update: 'update(entity, id, patch)',
      remove: 'remove(entity, id) -> bool',
      find: 'find(entity, {where,order,limit,cursor})',
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
      put: 'blobPut(id: string, value: string, type: string?) -> void',
      get: 'blobGet(id: string) -> string | null',
      del: 'blobDelete(id: string) -> void',
    },
    short: {
      put: 'blobPut(id, value)',
      get: 'blobGet(id) -> string|null',
      del: 'blobDelete(id)',
    },
    notes: 'Objects, not rows. The adapter owns bucket and naming.',
  },
  // One call, no conversation state: history belongs to the service, the
  // provider only turns messages into a reply. Local and cloud models expose
  // the same contract, so a body never names a vendor.
  llm: {
    effects: {
      chat: 'chat(messages: list<{ role: string, content: string }>, system: string | null) -> { content: string, model: string }',
      model: 'model() -> string',
    },
    short: {
      chat: 'chat(messages, system) -> {content,model}',
      model: 'model() -> string',
    },
    notes: 'messages are {role: user|assistant|system, content}. The adapter owns the wire format; the body never sees a vendor.',
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
      scan: 'scan() -> list<{ id: string, b: any }>',
      insert: 'insert(entity: string, record: any) -> any',
      fetch: 'fetch(entity: string, id: string) -> any | null',
      update: 'update(entity: string, id: string, patch: any) -> any',
      remove: 'remove(entity: string, id: string) -> bool',
      find: 'find(entity: string, query: { where?: any, order?: string, limit?: int, cursor?: string }) -> { items: list<any>, next: string | null }',
    },
    short: {
      get: 'load(id) -> {b,h}|null',
      set: 'save(id, {b,h})',
      del: 'del(id)',
      has: 'has(id) -> bool',
      takeIf: 'takeIf(id, record) -> bool',
      seen: 'seen(id) -> bool',
      scan: 'scan() -> list<{id,b}>',
      insert: 'insert(entity, record)',
      fetch: 'fetch(entity, id) -> record|null',
      update: 'update(entity, id, patch)',
      remove: 'remove(entity, id) -> bool',
      find: 'find(entity, {where,order,limit,cursor})',
    },
    notes: 'Rows, not keys. The adapter owns the table and TTL.',
  },
  // Server-to-client events. The body publishes, the page subscribes; the
  // provider is the transport, so a body never names a protocol or a broker.
  stream: {
    effects: {
      publish: 'publish(topic: string, message: any) -> number',
    },
    short: {
      publish: 'publish(topic, msg) -> n',
    },
    notes: 'topic is a plain string chosen by the body, e.g. "room:" + code. Returns how many clients received it; 0 means nobody is listening, which is not an error. With a redis binding every replica receives every event, so websocket clients may sit on any replica.',
  },
  // Reliable asynchronous handoff between operations. The body only
  // publishes; consumers are declared in the model — `job ... { on: alias.topic }`
  // — and the runtime owns the lifecycle: start, stop, graceful shutdown,
  // retry with a dead letter. None of that is body code.
  queue: {
    effects: {
      publish: 'publish(topic: string, message: any) -> boolean',
      dead: 'dead(topic: string) -> list<{ payload: any, attempts: number, lastError: string }>',
    },
    short: {
      publish: 'publish(topic, msg) -> bool',
      dead: 'dead(topic) -> list',
    },
    notes: 'Returns true when the broker accepted the message. Delivery to the consumer is at-least-once: a failed body (exception or { error }) is retried up to the job retry count, then moved to the dead letter queue, where dead(topic) reads it.',
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
