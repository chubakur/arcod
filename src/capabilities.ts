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
      update: 'update(entity: string, id: string, patch: any, guard?: any) -> any',
      updateWhere: 'updateWhere(entity: string, where: any, patch: any) -> { updated: int, record: any | null }',
      remove: 'remove(entity: string, id: string) -> bool',
      find: 'find(entity: string, query: { where?: any, order?: string, limit?: int, cursor?: string }) -> { items: list<any>, next: string | null }',
      count: 'count(entity: string, query: { where?: any }) -> int',
      aggregate: 'aggregate(entity: string, query: { field: string, op: string, where?: any }) -> number | null',
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
      update: 'update(entity, id, patch, {if})',
      updateWhere: 'updateWhere(entity, where, patch) -> {updated, record}',
      remove: 'remove(entity, id) -> bool',
      find: 'find(entity, {where,order,limit,cursor})',
      count: 'count(entity, {where}) -> int',
      aggregate: 'aggregate(entity, {field,op,where}) -> num|null',
    },
    notes: 'has tells whether the message still exists; seen tells whether it was already consumed. takeIf deletes only when the stored value equals expected. update(entity, id, patch, { if: { version: 3 } }) writes only while the stored record still holds the named values and answers Conflict (409) otherwise; without the fourth argument it is the unconditional read-modify-write. updateWhere is the same guard with arithmetic steps and a count instead of a 409.',
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
      chat: 'chat(messages: list<{ role: string, content: string }>, system: string | null, tools: list<{ name: string, description: string?, parameters: any }>?) -> { content: string, model: string, usage: { prompt: int, completion: int, total: int }, toolCalls: list<{ id: string, name: string, arguments: any }> }',
      model: 'model() -> string',
      embed: 'embed(texts: list<string>) -> list<list<float>>',
    },
    short: {
      chat: 'chat(messages, system, tools?) -> {content,model,usage,toolCalls}',
      model: 'model() -> string',
      embed: 'embed(texts) -> list<list<float>>',
    },
    notes: 'messages are {role: user|assistant|system, content}. tools is the allow-list the model may ask for (name, description, JSON-schema parameters); a reply that asks carries toolCalls [{id, name, arguments}] and content is "" when the model sent no prose. embed turns texts into vectors through the same endpoint (LLM_EMBED_MODEL or LLM_MODEL). The adapter owns the wire format; the body never sees a vendor.',
  },
  // Outbound HTTP to one declared host. The binding names the base URL, the
  // effect names the path: a body can ask for /v1/send, never for another host,
  // so an allow-list is the environment, not a string the body carries.
  endpoint: {
    effects: {
      call: 'call(alias: string, method: string, path: string, body: string | null, headers: any) -> { status: int, body: string }',
    },
    short: {
      call: 'call(alias, method, path, body?, headers?) -> {status, body}',
    },
    notes: 'Outbound HTTP through the bound endpoint provider. The bind carries the base URL (endpoint(url: "https://api.example.com")), so the body chooses only the path and headers; a non-2xx answer is a value { status, body }, not an exception. An absolute URL or a //host path is Forbidden before the request leaves.',
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
      update: 'update(entity: string, id: string, patch: any, guard?: any) -> any',
      updateWhere: 'updateWhere(entity: string, where: any, patch: any) -> { updated: int, record: any | null }',
      remove: 'remove(entity: string, id: string) -> bool',
      find: 'find(entity: string, query: { where?: any, order?: string, limit?: int, cursor?: string }) -> { items: list<any>, next: string | null }',
      count: 'count(entity: string, query: { where?: any }) -> int',
      aggregate: 'aggregate(entity: string, query: { field: string, op: string, where?: any }) -> number | null',
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
      update: 'update(entity, id, patch, {if})',
      updateWhere: 'updateWhere(entity, where, patch) -> {updated, record}',
      remove: 'remove(entity, id) -> bool',
      find: 'find(entity, {where,order,limit,cursor})',
      count: 'count(entity, {where}) -> int',
      aggregate: 'aggregate(entity, {field,op,where}) -> num|null',
    },
    notes: 'Rows, not keys. The adapter owns the table and TTL. update(entity, id, patch, { if: { version: 3 } }) re-reads the row under a lease and writes it only while it still holds the named values; a stale precondition is Conflict (409) and the row is untouched. updateWhere is the same guard with arithmetic steps and a count instead of a 409.',
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
      publishLater: 'publishLater(topic: string, message: any, delaySeconds: int) -> boolean',
      dead: 'dead(topic: string) -> list<{ payload: any, attempts: number, lastError: string }>',
      drop: 'drop(topic: string, payload: any) -> boolean',
    },
    short: {
      publish: 'publish(topic, msg) -> bool',
      publishLater: 'publishLater(topic, msg, delaySeconds) -> bool',
      dead: 'dead(topic) -> list',
      drop: 'drop(topic, payload) -> bool',
    },
    notes: 'Returns true when the broker accepted the message. Delivery to the consumer is at-least-once: a failed body (exception or { error }) is retried up to the job retry count, then moved to the dead letter queue, where dead(topic) reads it; drop(topic, payload) takes the first entry carrying that payload out of the list (false when there is none), so a replayed message does not stay there forever. publishLater(topic, message, delaySeconds) is the same publish with a due time: the message lands in the topic only when the delay has passed, and the consumer makes it arrive without any timer in the service — there is no scheduler, so a topic nobody consumes holds its delayed messages. The count is whole seconds, 0 publishes right away.',
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
  // hasOwn first: the key comes from a `use capability` clause, and a name
  // like toString would otherwise answer a prototype member.
  return Object.hasOwn(CAPABILITIES, key) ? CAPABILITIES[key] : null;
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
