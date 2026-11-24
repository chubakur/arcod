import type { ModuleNode, OpNode, ServiceNode, TypeDecl, TypeExpr } from '../ast.ts';
import { dialectNamed } from '../dialects.ts';
import { asOnce } from '../check.ts';
import { HANDLER_TEMPLATES, templateFor } from '../templates.ts';
import { SQL_STORE_SOURCE } from './sql-store.ts';
import { PG_STORE_SOURCE, PG_SQL_STORE_SOURCE } from './pg-store.ts';
import { IDENTITY_SOURCE } from './identity.ts';
import { BLOB_SOURCE } from './blob.ts';
import { LLM_SOURCE } from './llm.ts';
import { STREAM_SOURCE } from './stream.ts';
import { QUEUE_SOURCE, QUEUE_SHUTDOWN, OUTBOX_SHUTDOWN, OUTBOX_SOURCE, outboxSource, consumerSource } from './queue.ts';
import { storageKind, storageUse } from '../capabilities.ts';
import { endpointEnv } from '../providers.ts';
import { baseType, entitiesFromBodies, fieldDefault, migrationPlan, recordColumns, type Column, type DefaultValue } from '../migrate.ts';
import { boundsOf, constraintTable, lengthBoundsOf } from '../constraints.ts';
import type { ProviderRegistry } from '../registry.ts';

export interface EmitOptions {
  port?: number;
  // The sql driver is one contract with two wire clients; the build picks the
  // dialect and the emitted service carries only that client.
  dialect?: 'mysql' | 'postgres';
  reference?: boolean;
  impl?: Record<string, string>;
  // Shared helpers from impl/lib.mjs, bundled once before the bodies so every
  // body sees them as top-level functions (issue #39).
  implLib?: string;
  // Providers a plugin declares carry a runtime adapter; the registry is what
  // says which bindings need one and which methods it answers.
  registry?: ProviderRegistry;
  // Pages the service itself serves (ui render: ssr): route and final HTML.
  // dataOp names the parameterless GET whose result is folded into the page
  pages?: Array<{ route: string; html: string; dataOp?: string | null }>;
}

// ---------- plugin runtime adapters ----------
// A plugin provider can ship createAdapter(io): the build copies that file next
// to the service (plugins/<provider>.mjs), so the generated service stays
// dependency-free and the plugin package is not needed at runtime. The method
// names come from the capability's manifest signatures — the compiler never
// guesses what a capability means.

export interface PluginBinding {
  provider: string;
  package: string;
  target: string;
  exportName: string;
  capability: string;
  methods: Array<{ name: string; params: string[] }>;
}

// "publish(topic, message) -> Receipt" -> { name: 'publish', params: [...] }.
// A signature the compiler cannot read is skipped: the emitter never writes a
// method it does not understand.
function pluginMethod(signature: string): { name: string; params: string[] } | null {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open <= 0 || close < open) return null;
  const name = signature.slice(0, open).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const inner = signature.slice(open + 1, close).trim();
  const params = inner === ''
    ? []
    : inner.split(',').map((part) => part.trim().split(':')[0].trim()).filter((part) => part.length > 0);
  if (params.some((param) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(param))) return null;
  return { name, params };
}

function pluginCapabilityName(capability: string): string {
  return capability.includes('.') ? capability.split('.').pop()! : capability;
}

// io methods the runtime already owns. A capability signature with one of these
// names would shadow the store/blob/queue contract inside every body, so the
// build refuses it instead of emitting an object with a duplicate key.
const RESERVED_IO_METHODS = new Set([
  'load', 'save', 'scan', 'del', 'seen', 'takeIf', 'new', 'actor', 'users', 'chat', 'model',
  'publish', 'queuePublish', 'queueDead', 'remote', 'blobPut', 'blobGet', 'blobDelete', 'hash', 'verify', 'count', 'aggregate', 'embed',
]);

export function pluginBindings(mod: ModuleNode, registry?: ProviderRegistry): PluginBinding[] {
  const out: PluginBinding[] = [];
  for (const environment of mod.environments) for (const bind of environment.binds) {
    const spec = registry?.get(bind.provider);
    const runtime = spec?.runtime;
    if (!spec || !runtime) continue;
    if (out.some((entry) => entry.provider === spec.name)) continue;
    const methods = (registry?.signaturesFor(spec.capability) ?? [])
      .map(pluginMethod)
      .filter((method): method is { name: string; params: string[] } => method !== null);
    for (const method of methods) {
      if (RESERVED_IO_METHODS.has(method.name)) {
        throw new Error(
          'plugin capability ' + spec.capability + ' declares ' + method.name + '(), which collides with a built-in io method; rename the signature',
        );
      }
    }
    out.push({
      provider: spec.name,
      package: registry?.origin[spec.name] ?? '',
      target: 'plugins/' + spec.name + '.mjs',
      exportName: runtime.export ?? 'createAdapter',
      capability: spec.capability,
      methods,
    });
  }
  return out;
}

function pluginWireSource(bindings: PluginBinding[]): string {
  if (bindings.length === 0) return '';
  const manifest = bindings.map((binding) => ({
    provider: binding.provider,
    package: binding.package,
    target: binding.target,
    export: binding.exportName,
  }));
  return [
    '// ---------- plugin adapters ----------',
    '// Each entry was copied here by the build from the package that declared it.',
    '// The factory runs once, before the server listens: a broken adapter stops the',
    '// service with the provider named, instead of failing the first request.',
    'const PLUGIN_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';',
    'const PLUGIN_IO = {',
    '  env: process.env,',
    '  fetch: (input, init) => fetch(input, init),',
    '  log: (...args) => console.log(...args),',
    '};',
    'const PLUGIN_ADAPTERS = new Map();',
    'for (const entry of PLUGIN_MANIFEST) {',
    "  const loaded = await import(new URL(entry.target.slice('plugins/'.length), new URL('../plugins/', import.meta.url)));",
    '  const factory = loaded[entry.export];',
    '  if (typeof factory !== "function") {',
    '    throw new Error("plugin " + entry.package + " adapter " + entry.target + " exports no " + entry.export);',
    '  }',
    '  const adapter = await factory(PLUGIN_IO);',
    '  if (!adapter || typeof adapter !== "object") {',
    '    throw new Error("plugin " + entry.package + " adapter " + entry.target + " returned no adapter object");',
    '  }',
    '  PLUGIN_ADAPTERS.set(entry.provider, adapter);',
    '}',
    '// A body names a capability, never a package: the binding decides which',
    '// adapter answers, and a missing one is a startup error, not a 500 later.',
    'function pluginAdapter(provider) {',
    '  const adapter = PLUGIN_ADAPTERS.get(provider);',
    '  if (!adapter) throw new Error("no runtime adapter for plugin provider " + provider);',
    '  return adapter;',
    '}',
    '',
  ].join('\n');
}

const SERVICE_TEMPLATE = `import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const CONFIG = __CONFIG__;
CONFIG.timeoutMs = Number(process.env.ARCod_TIMEOUT_MS || CONFIG.timeoutMs || 30000);
const ROUTES = __ROUTES__;

// Pages rendered at build time and delivered by the service itself; the web
// container is then optional.
const PAGES = __PAGES__;
const ERRORS = __ERRORS__;
const STORES = __STORES__;
const MIGRATIONS = __MIGRATIONS__;

let inFlight = 0;

// ---------- observability ----------

const requestCtx = new AsyncLocalStorage();

const HISTO_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const METRICS = {
  requests: new Map(),
  durations: new Map(),
  errors: new Map(),
  capabilities: new Map(),
};

function metricRequests(method, route, status) {
  const key = method + '\\u0000' + route + '\\u0000' + status;
  METRICS.requests.set(key, (METRICS.requests.get(key) || 0) + 1);
}

function metricDuration(method, route, ms) {
  const key = method + '\\u0000' + route;
  const h = METRICS.durations.get(key) || { count: 0, sum: 0, buckets: new Array(HISTO_BUCKETS.length + 1).fill(0) };
  h.count += 1;
  h.sum += ms / 1000;
  let i = 0;
  while (i < HISTO_BUCKETS.length && ms / 1000 > HISTO_BUCKETS[i]) i++;
  h.buckets[i] += 1;
  METRICS.durations.set(key, h);
}

function metricError(operation) {
  METRICS.errors.set(operation, (METRICS.errors.get(operation) || 0) + 1);
}

function metricCapability(capability) {
  METRICS.capabilities.set(capability, (METRICS.capabilities.get(capability) || 0) + 1);
}

function finish(route, op, status, start, req) {
  metricRequests(req.method || 'GET', route, status);
  metricDuration(req.method || 'GET', route, Date.now() - start);
  const ctx = requestCtx.getStore() || {};
  console.log(JSON.stringify({
    level: 'access',
    ts: new Date().toISOString(),
    service: CONFIG.service,
    method: req.method,
    route,
    path: req.url,
    status,
    latency_ms: Date.now() - start,
    request_id: ctx.id || '',
    operation: op,
    actor_id: ctx.actor || '',
  }));
}

// ---------- tracing ----------

const spanCtx = new AsyncLocalStorage();
const TRACES = [];
let otlpTimer = null;

function startSpan(name, attrs) {
  const parent = spanCtx.getStore();
  return {
    name: name,
    attrs: attrs || {},
    traceId: parent && parent.traceId ? parent.traceId : randomUUID(),
    spanId: randomUUID(),
    parentId: parent ? parent.spanId : null,
    startMs: Date.now(),
    status: 'ok',
  };
}

function endSpan(span, status) {
  if (span.done) return;
  span.done = true;
  span.endMs = Date.now();
  span.status = status || 'ok';
  TRACES.push(span);
  if (TRACES.length > 4096) TRACES.shift();
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !otlpTimer) {
    otlpTimer = setInterval(flushOtlp, 5000);
    if (otlpTimer.unref) otlpTimer.unref();
  }
}

async function withSpan(name, attrs, fn) {
  const span = startSpan(name, attrs);
  try {
    return await spanCtx.run(span, fn);
  } catch (err) {
    endSpan(span, 'error');
    throw err;
  } finally {
    endSpan(span, 'ok');
  }
}

// Store calls are client spans: an operation span answers "how long did the
// request take", a store span answers "where did that time go". The proxy
// keeps the adapter untouched and only observes; capability and entity are
// the two facts every adapter call knows.
function spannedStore(inner, capability) {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const name = 'store.' + String(prop);
      return function (...args) {
        const first = args[0];
        const entity = typeof first === 'string' ? first.split(/[.:/]/)[0] : '';
        return withSpan(name, { capability, entity }, () => value.apply(target, args));
      };
    },
  });
}

function otlpHex(hex) {
  const h = String(hex || '').replace(/-/g, '').slice(0, 32).padEnd(32, '0');
  return Buffer.from(h, 'hex').toString('base64');
}

function flushOtlp() {
  if (TRACES.length === 0) return;
  const endpoint = String(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '');
  if (!endpoint) return;
  const batch = TRACES.splice(0, TRACES.length);
  const spans = batch.map((span) => ({
    traceId: otlpHex(span.traceId),
    spanId: otlpHex(span.spanId),
    parentSpanId: span.parentId ? otlpHex(span.parentId) : '',
    name: span.name,
    kind: 1,
    startTimeUnixNano: String(span.startMs) + '000000',
    endTimeUnixNano: String(span.endMs) + '000000',
    status: { code: span.status === 'error' ? 2 : 1 },
    attributes: Object.keys(span.attrs).map((key) => ({ key: key, value: { stringValue: String(span.attrs[key]) } })),
  }));
  const payload = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: CONFIG.service } }] },
      scopeSpans: [{ scope: { name: 'arcod' }, spans: spans }],
    }],
  });
  const url = endpoint + (endpoint.endsWith('/') ? 'v1/traces' : '/v1/traces');
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }).catch(() => {});
}


function prometheusMetrics() {
  const out = [];
  out.push('# HELP arcod_requests_total Total HTTP requests by method, route and status.');
  out.push('# TYPE arcod_requests_total counter');
  for (const [key, n] of METRICS.requests) {
    const parts = key.split('\\u0000');
    out.push('arcod_requests_total{method="' + parts[0] + '",route="' + parts[1] + '",status="' + parts[2] + '"} ' + n);
  }

  out.push('# HELP arcod_request_duration_seconds Request latency.');
  out.push('# TYPE arcod_request_duration_seconds histogram');
  for (const [key, h] of METRICS.durations) {
    const parts = key.split('\\u0000');
    const labels = 'method="' + parts[0] + '",route="' + parts[1] + '"';
    let cumulative = 0;
    for (let i = 0; i < HISTO_BUCKETS.length; i++) {
      cumulative += h.buckets[i];
      out.push('arcod_request_duration_seconds_bucket{' + labels + ',le="' + HISTO_BUCKETS[i] + '"} ' + cumulative);
    }
    cumulative += h.buckets[HISTO_BUCKETS.length];
    out.push('arcod_request_duration_seconds_bucket{' + labels + ',le="+Inf"} ' + cumulative);
    out.push('arcod_request_duration_seconds_sum{' + labels + '} ' + h.sum);
    out.push('arcod_request_duration_seconds_count{' + labels + '} ' + h.count);
  }

  out.push('# HELP arcod_errors_total Operation-level server error count.');
  out.push('# TYPE arcod_errors_total counter');
  for (const [op, n] of METRICS.errors) {
    out.push('arcod_errors_total{operation="' + op + '"} ' + n);
  }

  out.push('# HELP arcod_inflight_requests Requests currently being handled.');
  out.push('# TYPE arcod_inflight_requests gauge');
  out.push('arcod_inflight_requests ' + inFlight);

  out.push('# HELP arcod_capability_calls_total Calls into capabilities (store, remote).');
  out.push('# TYPE arcod_capability_calls_total counter');
  for (const [cap, n] of METRICS.capabilities) {
    out.push('arcod_capability_calls_total{capability="' + cap + '"} ' + n);
  }

  return out.join('\\n') + '\\n';
}

const ATOMIC_READ = __ATOMIC__;

const LUA_TAKE_IF = [
  "local v = redis.call('GET', KEYS[1])",
  "if not v then",
  "  if redis.call('EXISTS', KEYS[2]) == 1 then return 'gone' end",
  "  return 'missing'",
  "end",
  "if v ~= ARGV[1] then return 'conflict' end",
  "redis.call('DEL', KEYS[1])",
  "redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])",
  "return 'ok'",
].join('\\n');

const LUA_READ = [
  "local v = redis.call('GET', KEYS[1])",
  "if v then",
  "  redis.call('DEL', KEYS[1])",
  "  redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])",
  "  return {'ok', v}",
  "end",
  "if redis.call('EXISTS', KEYS[2]) == 1 then return {'gone'} end",
  "return {'missing'}",
].join('\\n');

// ---------- minimal RESP client (no dependencies) ----------

// __REDIS_START__
function parseReply(buf, offset) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf('\\r\\n', offset);
  if (lineEnd === -1) return null;
  const line = buf.toString('utf8', offset + 1, lineEnd);

  if (type === '+') return { value: line, next: lineEnd + 2 };
  if (type === '-') return { value: new Error(line), next: lineEnd + 2 };
  if (type === ':') return { value: Number(line), next: lineEnd + 2 };

  if (type === '$') {
    const len = Number(line);
    if (len === -1) return { value: null, next: lineEnd + 2 };
    const start = lineEnd + 2;
    if (buf.length < start + len + 2) return null;
    return { value: buf.toString('utf8', start, start + len), next: start + len + 2 };
  }

  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    const arr = [];
    let next = lineEnd + 2;
    for (let i = 0; i < count; i++) {
      const item = parseReply(buf, next);
      if (!item) return null;
      arr.push(item.value);
      next = item.next;
    }
    return { value: arr, next };
  }

  throw new Error('unexpected RESP type: ' + type);
}

class RedisStore {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.connecting = null;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    // A half-written reply from the previous connection means nothing on the
    // new one.
    this.buffer = Buffer.alloc(0);
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.connecting = null;
        resolve();
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        this.connecting = null;
        this.failPending(err);
        if (this.socket === socket) this.socket = null;
        reject(err);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this.failPending(new Error('redis connection closed'));
      });
      this.socket = socket;
    });
    return this.connecting;
  }

  // A broker restart must not leave a request waiting forever: every call in
  // flight gets the failure, and the next one opens a fresh socket.
  failPending(error) {
    const waiting = this.pending;
    this.pending = [];
    for (const item of waiting) item.reject(error);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let parsed;
      try {
        parsed = parseReply(this.buffer, 0);
      } catch (error) {
        // Corrupt stream: nobody can resynchronise it, so fail the callers
        // and drop the connection instead of throwing inside a socket event.
        this.failPending(error);
        if (this.socket) this.socket.destroy();
        return;
      }
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.next);
      const pending = this.pending.shift();
      if (!pending) continue;
      if (parsed.value instanceof Error) pending.reject(parsed.value);
      else pending.resolve(parsed.value);
    }
  }

  async command(...args) {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      const parts = ['*' + args.length + '\\r\\n'];
      for (const arg of args) {
        const value = String(arg);
        parts.push('$' + Buffer.byteLength(value) + '\\r\\n' + value + '\\r\\n');
      }
      this.socket.write(parts.join(''));
    });
  }

  async get(key) {
    const value = await this.command('GET', key);
    return value == null ? null : String(value);
  }

  async del(key) {
    return this.command('DEL', key);
  }

  async set(key, value, ttlMs) {
    return this.command('SET', key, value, 'PX', String(ttlMs));
  }

  async scan(prefix) {
    const keys = (await this.command('KEYS', (prefix || '') + '*')) || [];
    const out = [];
    for (const key of keys) {
      const value = await this.get(String(key));
      if (value != null) out.push({ key: String(key), value });
    }
    return out;
  }

  async exists(key) {
    const n = await this.command('EXISTS', key);
    return Number(n) === 1;
  }

  async claim(key) {
    const value = await this.command('SET', key, '1', 'NX');
    return value != null;
  }

  async takeIf(messageKey, goneKey, ttlMs, expected) {
    const reply = await this.command('EVAL', LUA_TAKE_IF, '2', messageKey, goneKey, String(expected), String(ttlMs));
    return String(reply) === 'ok';
  }

  async ping() {
    return this.command('PING');
  }

  async take(messageKey, goneKey, ttlMs, atomic) {
    if (atomic) {
      const reply = await this.command('EVAL', LUA_READ, '2', messageKey, goneKey, String(ttlMs));
      const state = Array.isArray(reply) ? reply[0] : null;
      if (state === 'ok') return { state: 'ok', value: String(reply[1]) };
      if (state === 'gone') return { state: 'gone' };
      return { state: 'missing' };
    }

    const value = await this.command('GET', messageKey);
    if (value !== null) {
      await this.command('DEL', messageKey);
      await this.command('SET', goneKey, '1', 'PX', String(ttlMs));
      return { state: 'ok', value: String(value) };
    }
    if ((await this.command('EXISTS', goneKey)) === 1) return { state: 'gone' };
    return { state: 'missing' };
  }
}

// __REDIS_END__
class MemoryStore {
  constructor() {
    this.map = new Map();
    this.outbox = [];
  }

  async set(key, value, ttlMs) {
    this.map.set(key, { value: String(value), expires: Date.now() + ttlMs });
    return 'OK';
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key) {
    return this.map.delete(key) ? 1 : 0;
  }

  async claim(key) {
    const entry = this.map.get(key);
    if (entry && entry.expires > Date.now()) return false;
    this.map.set(key, { value: '1', expires: Infinity });
    return true;
  }

  async scan(prefix) {
    const out = [];
    for (const [key, entry] of this.map) {
      if (entry.expires <= Date.now()) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({ key, value: entry.value });
    }
    return out;
  }

  async exists(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  async takeIf(messageKey, goneKey, ttlMs, expected) {
    const entry = this.map.get(messageKey);
    if (!entry || entry.expires <= Date.now()) return false;
    if (String(entry.value) !== String(expected)) return false;
    this.map.delete(messageKey);
    this.map.set(goneKey, { value: '1', expires: Date.now() + ttlMs });
    return true;
  }

  async ping() {
    return 'PONG';
  }

  async take(messageKey, goneKey, ttlMs, atomic) {
    const entry = this.map.get(messageKey);
    const value = entry && entry.expires > Date.now() ? entry.value : null;
    if (!atomic) {
      // Deliberate yield: without an atomic rule, read and delete are separate steps.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (value !== null) {
      this.map.delete(messageKey);
      this.map.set(goneKey, { value: '1', expires: Date.now() + ttlMs });
      return { state: 'ok', value };
    }
    this.map.delete(messageKey);
    if ((await this.get(goneKey)) !== null) return { state: 'gone' };
    return { state: 'missing' };
  }

  // Outbox + transaction are no-ops in-process: a body completes or throws
  // before the dispatcher ever sees the row, so begin/commit are vacuous and
  // the pending list is just an array the dispatcher drains.
  async begin() {}
  async commit() {}
  async rollback() {}
  async outboxAppend(id, topic, payload) {
    this.outbox.push({ id, topic, payload, publishedAt: null, at: Date.now() });
    return true;
  }
  async outboxPending(limit) {
    return this.outbox.filter((row) => row.publishedAt == null).sort((a, b) => a.at - b.at).slice(0, Number(limit || 100));
  }
  async outboxMark(id) {
    const row = this.outbox.find((item) => item.id === id);
    if (row) row.publishedAt = Date.now();
    return true;
  }

  // Entity table methods: the sql driver's in-memory store implements the
  // typed record surface (fetch/insert/update/remove/find) so arcod test runs
  // sql examples without a live MySQL. Same key layout as the kv adapter: a
  // record lives under tbl:<table>:<id>, unique fields claim a unique key.
  entityKey(table, id) {
    return 'tbl:' + table + ':' + String(id);
  }

  async entityFetch(table, columns, id) {
    const raw = await this.get(this.entityKey(table, id));
    if (raw == null) return null;
    const rec = recordOf(raw);
    return rec && typeof rec === 'object' ? rec : null;
  }

  async entityInsert(table, columns, record, groups) {
    const value = Object.assign({}, record || {});
    if (value.id == null || value.id === '') throw new ArcodError('Invalid', { message: 'insert ' + table + ': missing id' });
    const key = this.entityKey(table, value.id);
    if (await this.exists(key)) throw new ArcodError('Conflict');
    const claimed = [];
    for (const group of groups || []) {
      const values = group.map((field) => value[field]);
      if (values.some((item) => item == null)) continue;
      const claim = uniqueKey(table, group.join(','), values);
      if (!(await this.claim(claim))) {
        for (const item of claimed) await this.del(item);
        throw new ArcodError('Conflict');
      }
      claimed.push(claim);
    }
    await this.set(key, JSON.stringify({ b: value, h: null }), Infinity);
    return value;
  }

  async entityUpdate(table, columns, id, patch, groups) {
    const key = this.entityKey(table, id);
    const raw = await this.get(key);
    if (raw == null) throw new ArcodError('NotFound');
    const current = recordOf(raw);
    const base = current && typeof current === 'object' ? current : {};
    const value = Object.assign({}, base, patch || {}, { id: String(id) });
    const claimed = [];
    const released = [];
    for (const group of groups || []) {
      const before = group.map((field) => base[field]);
      const after = group.map((field) => value[field]);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (before.some((item) => item != null)) {
        await this.del(uniqueKey(table, group.join(','), before));
        released.push({ group, before });
      }
    }
    for (const group of groups || []) {
      const before = group.map((field) => base[field]);
      const after = group.map((field) => value[field]);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after.some((item) => item == null)) continue;
      const claim = uniqueKey(table, group.join(','), after);
      if (!(await this.claim(claim))) {
        for (const item of claimed) await this.del(item);
        for (const rel of released) await this.claim(uniqueKey(table, rel.group.join(','), rel.before));
        throw new ArcodError('Conflict');
      }
      claimed.push(claim);
    }
    await this.set(key, JSON.stringify({ b: value, h: null }), Infinity);
    return value;
  }

  async entityRemove(table, columns, id, groups) {
    const key = this.entityKey(table, id);
    const raw = await this.get(key);
    if (raw == null) return false;
    const current = recordOf(raw);
    await this.del(key);
    for (const group of groups || []) {
      const values = group.map((field) => current && current[field]);
      if (values.some((item) => item == null)) continue;
      await this.del(uniqueKey(table, group.join(','), values));
    }
    return true;
  }

  // A count is a total, not a page: no limit and no cursor, only the same
  // where filter the driver's find applies. The result is independent of
  // limit, so a counter no longer walks pages with a ceiling.
  async entityCount(table, columns, query) {
    const opts = query || {};
    const prefix = 'tbl:' + table + ':';
    const rows = await this.scan(prefix);
    let items = rows.map((row) => recordOf(row.value));
    if (opts.where) items = items.filter((item) => matchesWhere(item, opts.where));
    return items.length;
  }

  // An aggregate is a total, not a page: sum/avg/min/max over one numeric
  // field with the same filters find applies. A report that silently sums
  // strings is worse than a 400, so an unknown op, an unknown field or a
  // non-numeric value throws Invalid with the field named.
  async entityAggregate(table, columns, query) {
    const opts = query || {};
    const field = String(opts.field || '');
    const op = String(opts.op || '');
    if (op !== 'sum' && op !== 'avg' && op !== 'min' && op !== 'max') {
      throw new ArcodError('Invalid', { message: 'aggregate: unknown op "' + op + '"; use sum, avg, min or max' });
    }
    const column = columns.find((item) => item.name === field);
    if (!column) {
      throw new ArcodError('Invalid', { message: 'aggregate: unknown field "' + field + '"' });
    }
    // A total needs a number. Folding rows answered 0 for an empty table, and
    // a text column of digits was summed as numbers; sql either did the same
    // or failed inside the driver. The declared type decides, not the rows.
    if (!['int', 'float', 'number', 'decimal'].includes(column.base)) {
      throw new ArcodError('Invalid', { message: 'aggregate: field "' + field + '" is not numeric' });
    }
    const rows = await this.scan('tbl:' + table + ':');
    let items = rows.map((row) => recordOf(row.value));
    if (opts.where) items = items.filter((item) => matchesWhere(item, opts.where));
    let total = 0;
    let seen = 0;
    let best = null;
    for (const item of items) {
      const raw = item && typeof item === 'object' ? item[field] : null;
      if (raw == null) continue;
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        throw new ArcodError('Invalid', { message: 'aggregate: field "' + field + '" is not numeric' });
      }
      seen += 1;
      total += number;
      if (best == null || (op === 'min' ? number < best : op === 'max' ? number > best : false)) best = number;
    }
    if (op === 'sum') return total;
    if (seen === 0) return null;
    if (op === 'avg') return total / seen;
    return best;
  }

  async entityFind(table, columns, query) {
    const opts = query || {};
    const requested = Number(opts.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;
    const order = parseOrder(opts.order);
    const prefix = 'tbl:' + table + ':';
    const rows = await this.scan(prefix);
    let items = rows.map((row) => ({ id: row.key.slice(prefix.length), value: recordOf(row.value) }));
    if (opts.where) items = items.filter((item) => matchesWhere(item.value, opts.where));
    items.sort((left, right) => {
      for (const rule of order) {
        const a = left.value && typeof left.value === 'object' ? sortValue(left.value[rule.field]) : null;
        const b = right.value && typeof right.value === 'object' ? sortValue(right.value[rule.field]) : null;
        const diff = compareValues(a, b);
        if (diff !== 0) return diff * rule.dir;
      }
      return compareValues(left.id, right.id);
    });
    if (opts.cursor) {
      const at = decodeCursor(opts.cursor);
      // A cursor from another order (or a corrupt one) used to vanish as if
      // it were no cursor: the page started over and a client that follows
      // next looped forever. The shape is checked here for the same reason
      // the sql stores check it.
      if (!at || !Array.isArray(at.v) || at.v.length !== order.length) {
        throw new ArcodError('Invalid', {
          message: 'cursor: not a page of this order (expected ' + order.length + ' sort value' + (order.length === 1 ? '' : 's') + '); ask for the first page with this order',
        });
      }
      // A cursor's values are spelled by the store that minted it: kv sorts a
      // moment as an epoch number, MySQL prints '2026-01-01 00:00:00.000',
      // Postgres leaves the space out. Comparing a foreign spelling answers a
      // silently wrong page, so the tag is refused and the client starts over.
      if (at.s && at.s !== 'kv') {
        throw new ArcodError('Invalid', { message: 'cursor: issued by the ' + at.s + ' store; ask for the first page here' });
      }
      const after = (item) => {
        for (let index = 0; index < order.length; index++) {
          const rule = order[index];
          const value = item.value && typeof item.value === 'object' ? sortValue(item.value[rule.field]) : null;
          const diff = compareValues(value, at.v[index]);
          if (diff !== 0) return diff * rule.dir;
        }
        return compareValues(item.id, at.id);
      };
      items = items.filter((item) => after(item) > 0);
    }
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    let next = null;
    if (hasMore && page.length > 0) {
      const tail = page[page.length - 1];
      next = encodeCursor(order.map((rule) => (tail.value && typeof tail.value === 'object' ? sortValue(tail.value[rule.field]) : null)), tail.id, 'kv');
    }
    return {
      items: page.map((item) => (item.value && typeof item.value === 'object' && !Array.isArray(item.value) ? Object.assign({ id: item.id }, item.value) : item.value)),
      next,
    };
  }
}

__SQL_STORE__
__STORE_SELECT__
__PLUGIN_WIRE__

// ---------- entity store ----------

// A body never names a provider; it names an entity. The adapter owns the key
// layout, the unique index and the ordering, so the same body runs on kv or sql.
function ArcodError(name, fields) {
  this.name = name;
  this.error = name;
  this.message = name;
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) this[key] = fields[key];
  }
}
ArcodError.prototype = Object.create(Error.prototype);
ArcodError.prototype.constructor = ArcodError;

function recordOf(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'b' in parsed) return parsed.b;
    return parsed;
  } catch {
    return raw;
  }
}

function uniqueKey(entity, field, value) {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
  return 'unique:' + entity + ':' + field + ':' + text;
}

function sortValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value);
  if (/^\\d{4}-\\d{2}-\\d{2}/.test(text)) {
    const time = Date.parse(text);
    if (!Number.isNaN(time)) return time;
  }
  return text;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}

function parseOrder(order) {
  const list = Array.isArray(order) ? order : String(order || 'id').split(',');
  return list.map((entry) => {
    const parts = String(entry).trim().split(/\\s+/);
    return { field: parts[0], dir: (parts[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1 };
  });
}

function encodeCursor(values, id, store) {
  return Buffer.from(JSON.stringify({ v: values, id, s: store })).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function scalarOf(cond) {
  return cond === null || typeof cond !== 'object' || Array.isArray(cond);
}

const KNOWN_WHERE_OPERATORS = ['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte'];

// eq/ne/in compare cells, not references: a list or record field is stored as
// JSON, and sql compares the value. A reference comparison made every such
// filter match nothing on kv. The value, not the text: a record is an unordered
// set of keys, so two spellings of the same record are equal - sql compares
// JSON values that way, and comparing JSON.stringify output made kv miss a row
// whose keys were inserted in another order.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left == null || right == null) return left == right;
  if (typeof left === 'object' || typeof right === 'object') {
    try {
      return canonicalJson(left) === canonicalJson(right);
    } catch {
      return false;
    }
  }
  return left == right;
}

function matchesWhere(value, where) {
  for (const field of Object.keys(where || {})) {
    const cond = where[field];
    const actual = value && typeof value === 'object' ? value[field] : null;
    if (scalarOf(cond)) {
      if (!sameValue(actual, cond)) return false;
      continue;
    }
    for (const op of Object.keys(cond)) {
      if (!KNOWN_WHERE_OPERATORS.includes(op)) {
        throw new ArcodError('Invalid', { message: 'unknown where operator "' + op + '"' });
      }
      const expected = cond[op];
      // A shape mistake in the query is not a filter that matches nothing: on
      // sql the clause used to be dropped (every row) while kv answered an
      // empty page. Both drivers now answer 400 with the field and the type.
      if (op === 'in' && !Array.isArray(expected)) {
        throw new ArcodError('Invalid', {
          message: 'where "in" on "' + field + '" needs a list, got ' + (expected === null ? 'null' : typeof expected),
        });
      }
      // SQL answers NULL for a comparison against a null operand, so no row
      // matches; kv used to sort nulls last and let gt return records the
      // field is absent from. A null on either side never matches, and a null
      // on the right is a mistake worth naming rather than an empty page.
      if (op !== 'in' && expected === null) {
        throw new ArcodError('Invalid', {
          message: 'where "' + op + '" on "' + field + '" compares with null; a null never matches, use a concrete value',
        });
      }
      // SQL compares NULL with anything as NULL, so a row whose field has no
      // value never matches -- and that includes "ne": col <> 'x' is not
      // true for a NULL col. kv read an absent field as "different from x",
      // and an empty contains hit it too (''.includes('')), so the same
      // filter found rows sql never returns. eq and in already agreed by
      // accident; the guard now names the rule once.
      if (actual == null) return false;
      if (op === 'eq' && !sameValue(actual, expected)) return false;
      if (op === 'ne' && sameValue(actual, expected)) return false;
      if (op === 'in' && !(Array.isArray(expected) && expected.some((item) => sameValue(item, actual)))) return false;
      // A list or record field is JSON text in a SQL column, so contains
      // matched a substring there. On kv String() turned a list into "a,b"
      // and a record into "[object Object]", so the same query found nothing.
      // Both drivers compare the JSON text now.
      if (op === 'contains') {
        // A bool column holds 1/0: String(true) matched on kv while sql put
        // "1" in the text, so the same query found different rows.
        const haystack = actual == null
          ? ''
          : typeof actual === 'object'
            ? JSON.stringify(actual)
            : typeof actual === 'boolean' ? (actual ? '1' : '0') : String(actual);
        if (!haystack.includes(String(expected))) return false;
      }
      if (op === 'gt' && !(compareValues(sortValue(actual), sortValue(expected)) > 0)) return false;
      if (op === 'gte' && !(compareValues(sortValue(actual), sortValue(expected)) >= 0)) return false;
      if (op === 'lt' && !(compareValues(sortValue(actual), sortValue(expected)) < 0)) return false;
      if (op === 'lte' && !(compareValues(sortValue(actual), sortValue(expected)) <= 0)) return false;
    }
  }
  return true;
}

function requestEntity(entity) {
  const meta = STORES[entity];
  if (!meta) {
    // A typo in a body used to be an anonymous 500: the operator had an access
    // line and nothing else. The body names the literal and the declared set,
    // so the mistake is readable from the response and the log alike.
    const declared = Object.keys(STORES).sort();
    throw new ArcodError('Internal', {
      message: 'unknown entity "' + entity + '"' + (declared.length > 0 ? '; declared: ' + declared.join(', ') : '; no entity is declared'),
    });
  }
  return meta;
}

// A where key the entity does not declare is a typo, not a filter: on sql the
// clause used to be dropped (every row) and kv answered an empty page. Both
// drivers now name the field and the declared ones.
// This body is emitted verbatim into index.mjs: no TypeScript-only syntax.
// A datetime filter names the same instant however it is spelled: kv compares
// the stored text, so "+02:00" in a query matched nothing while sql converted
// it and matched. The filter is canonicalized exactly like a record field, and
// one the column cannot hold is a 400 rather than a page that misses rows.
function datetimeCondition(value, field) {
  const canonical = canonicalDateTime(value);
  if (canonical === null) {
    throw new ArcodError('Invalid', { message: 'where: ' + field + ' must be an ISO 8601 datetime' });
  }
  return canonical;
}

function checkWhereFields(meta, where) {
  for (const field of Object.keys(where || {})) {
    const column = meta.columns.find((item) => item.name === field);
    if (!column) {
      throw new ArcodError('Invalid', {
        message: 'where: unknown field "' + field + '"; declared: ' + meta.columns.map((item) => item.name).join(', '),
      });
    }
    // An order comparison needs a scalar: String() of a list or record is
    // "a,b"/"[object Object]", so gt/lt answered nonsense on kv, and sql
    // compared the JSON column against a string. eq/ne/in/contains still name
    // the value.
    if (column.base === 'json' || column.base === 'list' || column.base === 'map') {
      const raw = where[field];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const op of Object.keys(raw)) {
          if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
            throw new ArcodError('Invalid', {
              message: 'where "' + op + '" on "' + field + '" needs a scalar field, not a ' + column.base,
            });
          }
        }
      }
    }
    // A container of instants is compared by its JSON text, so the expected
    // value needs the stored spelling too: the same instant written with an
    // offset matched no row while the scalar column matched it.
    const instantDepth = (meta.instants || {})[field];
    if (instantDepth) {
      const raw = where[field];
      if (raw === null || raw === undefined) continue;
      if (Array.isArray(raw)) {
        where[field] = canonicalInstants(raw, instantDepth, 'where', field);
        continue;
      }
      if (typeof raw === 'object') {
        for (const op of Object.keys(raw)) {
          if (!KNOWN_WHERE_OPERATORS.includes(op) || op === 'contains') continue;
          const expected = raw[op];
          if (expected === null || expected === undefined) continue;
          if (op === 'in') {
            if (Array.isArray(expected)) raw[op] = expected.map((item) => canonicalInstants(item, instantDepth, 'where', field));
            continue;
          }
          if (op === 'eq' || op === 'ne') raw[op] = canonicalInstants(expected, instantDepth, 'where', field);
        }
        continue;
      }
      // A bare scalar cannot be equal to a list; matchesWhere answers no rows,
      // so it stays a filter and not a shape error.
      continue;
    }
    // bytes and the non-integer numbers have no stable text: kv holds the
    // value as stored, MySQL casts the BLOB to raw bytes and DECIMAL(30,6) to
    // "1.500000", Postgres renders a bytea escape and its own exponent. The
    // same contains would match three different things, so it is refused;
    // eq/ne/in and a range compare the value itself.
    if (column.base === 'bytes' || column.base === 'decimal' || column.base === 'float' || column.base === 'number') {
      const raw = where[field];
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'contains')) {
        throw new ArcodError('Invalid', {
          message: column.base === 'bytes'
            ? 'where "contains" on "' + field + '" needs text, and a bytes field has none: kv holds the bytes, MySQL the raw BLOB and Postgres a bytea escape; compare bytes with eq/ne/in'
            : 'where "contains" on "' + field + '" searches text, and a ' + column.base + ' column has no stable text: each store picks its own scale and exponent; compare numbers with eq/ne/in or a range',
        });
      }
    }
    if (column.base !== 'datetime') continue;
    const cond = where[field];
    if (cond === null || cond === undefined) continue;
    if (scalarOf(cond)) {
      where[field] = datetimeCondition(cond, field);
      continue;
    }
    for (const op of Object.keys(cond)) {
      // contains on a moment is text search over a spelling no two stores
      // share: kv holds "2026-01-01T00:00:00Z", MySQL "2026-01-01
      // 00:00:00.000" and Postgres "2026-01-01 00:00:00". The same query
      // therefore found different rows - "T00" matched only kv, a space only
      // SQL, ".000" only MySQL. A moment has an order, so a range names the
      // window instead.
      if (op === 'contains') {
        throw new ArcodError('Invalid', {
          message: 'where "contains" on "' + field + '" searches text, and a datetime is spelled differently by each store; use gt/gte/lt/lte',
        });
      }
      if (!KNOWN_WHERE_OPERATORS.includes(op)) continue;
      const expected = cond[op];
      if (expected === null || expected === undefined) continue;
      if (op === 'in') {
        // A non-list is named by matchesWhere; a list is checked element-wise.
        if (Array.isArray(expected)) cond[op] = expected.map((item) => (item === null ? item : datetimeCondition(item, field)));
        continue;
      }
      cond[op] = datetimeCondition(expected, field);
    }
  }
}

// A sort key the entity does not declare is the same class of mistake: kv
// sorted by an undefined value (a no-op order), sql sent an unknown column to
// the driver (500). Both name the field and the declared columns now.
function checkOrderFields(meta, order) {
  for (const rule of order) {
    const column = meta.columns.find((item) => item.name === rule.field);
    if (!column) {
      throw new ArcodError('Invalid', {
        message: 'order: unknown field "' + rule.field + '"; declared: ' + meta.columns.map((item) => item.name).join(', '),
      });
    }
    // A container is JSON: kv sorted its String() ("[object Object]" for a
    // record, "a,b" for a list) while sql sorted the JSON text, so the same
    // order answered two different pages. Only a scalar has an order.
    if (column.base === 'json' || column.base === 'list' || column.base === 'map') {
      throw new ArcodError('Invalid', {
        message: 'order: field "' + rule.field + '" is a ' + column.base + '; order only names a scalar field',
      });
    }
  }
}

// A record field the entity does not declare is a bug: kv keeps it, while the
// sql stores name the columns in every statement and drop it - the same insert
// would mean two different records per driver. Name it instead.
// A datetime is an instant, and both drivers store the same one or the record
// means two things. kv keeps the record verbatim as JSON; mysql keeps a
// DATETIME(3) column and postgres a timestamptz, and both spell it back as
// UTC. So the accepted text is canonicalized here, once: a T separator,
// milliseconds, a Z suffix. An offset is converted (not stripped: +03:00 is a
// different instant), a missing zone means UTC, a bare date means midnight.
// A fourth fraction digit is refused instead of cut: silently dropping
// microseconds is the drift this check exists to stop.
const DATE_TIME = /^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/;

function canonicalDateTime(value) {
  if (typeof value !== 'string') return null;
  const parts = DATE_TIME.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4] || 0);
  const minute = Number(parts[5] || 0);
  const second = Number(parts[6] || 0);
  const fraction = parts[7] || '';
  if (fraction.length > 3) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  const zone = parts[8];
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const zoneHour = Number(digits.slice(0, 2));
    const zoneMinute = Number(digits.slice(2));
    if (zoneHour > 23 || zoneMinute > 59) return null;
    offset = (zone.charAt(0) === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  }
  const millis = Number((fraction + '000').slice(0, 3));
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // 2026-02-30 is not a day: Date rolls it into March, so the calendar day
  // the text names must be the one it lands on before the offset is applied.
  const named = new Date(local);
  if (named.getUTCFullYear() !== year || named.getUTCMonth() !== month - 1 || named.getUTCDate() !== day) return null;
  const iso = new Date(local - offset * 60000).toISOString();
  return iso.slice(0, 19) + (millis === 0 ? '' : '.' + iso.slice(20, 23)) + 'Z';
}

// A field declared as a container of instants (list<datetime>,
// map<list<datetime>>) is JSON text, and neither driver types it: the row read
// back exactly as the caller wrote it, while a scalar datetime column read back
// canonical. STORES[entity].instants says how many list/map wrappers sit above
// the instant, so the same canonical spelling lands at every leaf.
function canonicalInstants(value, depth, place, field) {
  if (value === null || value === undefined) return value;
  if (depth === 0) {
    const canonical = canonicalDateTime(value);
    if (canonical === null) {
      throw new ArcodError('Invalid', { message: place + ': ' + field + ' must hold an ISO 8601 datetime' });
    }
    return canonical;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalInstants(item, depth - 1, place, field));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = canonicalInstants(value[key], depth - 1, place, field);
    return out;
  }
  throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be a list or map of datetime' });
}

// An id names the row: a patch carrying another value would move the primary
// key on sql and leave the stored record disagreeing with its key on kv. An
// echo of the same id (a client resending the whole record) stays legal.
function checkUpdateKey(entity, id, patch) {
  if (!patch || patch.id == null) return;
  if (String(patch.id) === String(id)) return;
  throw new ArcodError('Invalid', { message: 'update ' + entity + ': id cannot be changed' });
}

// The email and url shapes of the op boundary, written as plain code: a regex
// inside this emitted template needs its backslashes doubled at every level, and
// one missed level silently turns [^\s@] into [^s@].
function hasSpace(text) {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) <= 32) return true;
  }
  return false;
}

function looksLikeEmail(text) {
  if (hasSpace(text)) return false;
  const at = text.indexOf('@');
  if (at <= 0 || text.indexOf('@', at + 1) !== -1) return false;
  const domain = text.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function looksLikeUrl(text) {
  if (hasSpace(text)) return false;
  const mark = text.indexOf('://');
  if (mark <= 0) return false;
  const scheme = text.slice(0, mark).toLowerCase();
  for (const ch of scheme) {
    if (!(ch >= 'a' && ch <= 'z') && !(ch >= '0' && ch <= '9') && ch !== '+' && ch !== '.' && ch !== '-') return false;
  }
  return scheme.charCodeAt(0) >= 97 && scheme.charCodeAt(0) <= 122 && mark + 3 < text.length;
}

function checkRecordFields(meta, record, place) {
  // A record is an object. A body that hands a string or null to io.insert used
  // to fail later and worse: kv's Object.assign spread the characters into
  // numbered fields, and a null died on .id as a 500 instead of a named 400.
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ArcodError('Invalid', { message: place + ': the record must be an object' });
  }
  for (const field of Object.keys(record)) {
    if (!meta.columns.some((column) => column.name === field)) {
      throw new ArcodError('Invalid', {
        message: place + ': unknown field "' + field + '"; declared: ' + meta.columns.map((column) => column.name).join(', '),
      });
    }
  }
  // A field declared without ? is not optional: it cannot hold null, and an
  // insert cannot leave it out (a declared default fills it before this runs).
  // kv stored the absence anyway (the row simply had no name) while a NOT NULL
  // column failed inside the driver as a 500, so the same call answered two
  // things. The column list already says which fields are optional.
  for (const column of meta.columns) {
    if (!(column.name in record)) {
      if (place.indexOf('insert ') === 0 && column.name !== 'id' && !column.nullable && column.default == null) {
        throw new ArcodError('Invalid', { message: place + ': missing ' + column.name });
      }
      continue;
    }
    if (record[column.name] == null && !column.nullable) {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' is not nullable' });
    }
  }
  // A text field stores text: kv kept the number 42 a body happened to carry,
  // sql coerced it to '42', so the same insert answered two shapes. The base
  // name comes from the column list both facades already ship.
  for (const column of meta.columns) {
    if (column.base !== 'string' && column.base !== 'email' && column.base !== 'url' && column.base !== 'uri' && column.base !== 'uuid' && column.base !== 'bytes') continue;
    const value = record[column.name];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' must be a string' });
    }
  }
  // A number is stored as a number: a numeric string went to kv verbatim and
  // became a number in sql, so the same row read differently per driver.
  for (const column of meta.columns) {
    if (column.base !== 'int' && column.base !== 'number' && column.base !== 'float' && column.base !== 'decimal') continue;
    const value = record[column.name];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' must be a number' });
    }
    // An int column holds whole numbers whether or not it declares a bound:
    // kv kept 1.5 while a BIGINT column either truncated it or failed at the
    // driver, so the same insert stored two different values.
    if (column.base === 'int' && !Number.isInteger(value)) {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' must be an integer' });
    }
  }
  // A boolean field stores a boolean: sql read the truthiness, so the string
  // "false" became TRUE while kv kept "false" — one insert, two answers.
  for (const column of meta.columns) {
    if (column.base !== 'bool' && column.base !== 'boolean') continue;
    const value = record[column.name];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' must be a boolean' });
    }
  }
  // A datetime field holds an instant, as text: kv kept "yesterday" or 42
  // while mysql answered 500 at the driver, so one insert had three outcomes.
  // What is stored is the canonical spelling: kv keeps the value verbatim, so
  // an accepted offset or a space would read back differently than mysql's.
  for (const column of meta.columns) {
    if (column.base !== 'datetime') continue;
    const value = record[column.name];
    if (value === null || value === undefined) continue;
    const canonical = canonicalDateTime(value);
    if (canonical === null) {
      throw new ArcodError('Invalid', { message: place + ': ' + column.name + ' must be an ISO 8601 datetime' });
    }
    record[column.name] = canonical;
  }
  // A container of instants takes the same spelling at every leaf, so a row
  // does not read back differently depending on how the caller wrote it.
  const instantFields = meta.instants || {};
  for (const field of Object.keys(instantFields)) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    record[field] = canonicalInstants(value, instantFields[field], place, field);
  }
  // A container field is a container: a bare string where the type says
  // list<string> took the row out of its own declaration. kv stored it, mysql
  // kept the JSON text of a string in a JSON column, and a client that trusted
  // the schema broke on the element it expected. Only the shape is checked
  // here; the element type is the contract layer's. A container of instants
  // already has its own rule above, so it keeps its own message.
  const shapes = meta.shapes || {};
  for (const field of Object.keys(shapes)) {
    if (instantFields[field]) continue;
    const value = record[field];
    if (value === null || value === undefined) continue;
    const shape = shapes[field];
    if (shape === 'list') {
      if (!Array.isArray(value)) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be a list' });
      }
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ArcodError('Invalid', {
        message: place + ': ' + field + (shape === 'map' ? ' must be a map' : ' must be an object'),
      });
    }
  }
  // An enum field holds one of its members. The op boundary validates an
  // input, but a record built inside a body never crosses that boundary, and
  // both stores kept a non-member in a status column as if the enum allowed it.
  const enums = meta.enums || {};
  for (const field of Object.keys(enums)) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    if (!enums[field].includes(String(value))) {
      throw new ArcodError('Invalid', {
        message: place + ': ' + field + ' must be one of ' + enums[field].join(', '),
      });
    }
  }
  // A field declared email or url holds a value of that format. The op
  // boundary validates an input; a record built inside a body is the other way
  // in, and both stores kept "not-an-email" in an email column.
  const formats = meta.formats || {};
  for (const field of Object.keys(formats)) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (formats[field] === "email" && !looksLikeEmail(text)) {
      throw new ArcodError("Invalid", { message: place + ": " + field + " must be an email" });
    }
    if (formats[field] === "uri" && !looksLikeUrl(text)) {
      throw new ArcodError("Invalid", { message: place + ": " + field + " must be a url" });
    }
  }
  // Declared bounds are part of the entity: a value outside them would store
  // the row the schema promises clients never see, so both facades answer 400
  // with the field and the bound instead of keeping it.
  const bounds = meta.bounds || {};
  for (const field of Object.keys(bounds)) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    const rule = bounds[field];
    if (rule.minLength !== undefined || rule.maxLength !== undefined) {
      if (typeof value !== 'string') {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be a string' });
      }
      const length = rule.bytes ? Buffer.byteLength(value, 'utf8') : [...value].length;
      const unit = rule.bytes ? 'bytes' : 'characters';
      if (rule.minLength !== undefined && length < rule.minLength) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be at least ' + rule.minLength + ' ' + unit });
      }
      if (rule.maxLength !== undefined && length > rule.maxLength) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be at most ' + rule.maxLength + ' ' + unit });
      }
    }
    if (rule.min !== undefined || rule.max !== undefined) {
      const number = typeof value === 'number' ? value : Number(value);
      if (rule.integer && !Number.isInteger(number)) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be an integer' });
      }
      if (!rule.integer && !Number.isFinite(number)) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be a number' });
      }
      if (rule.min !== undefined && number < rule.min) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be >= ' + rule.min });
      }
      if (rule.max !== undefined && number > rule.max) {
        throw new ArcodError('Invalid', { message: place + ': ' + field + ' must be <= ' + rule.max });
      }
    }
  }
}

// Declared schema defaults fill only absent fields: an explicit value (even
// null) from the body always wins, so a default is never a validator.
function withDefaults(meta, record) {
  if (!record || typeof record !== 'object') return record;
  const value = Object.assign({}, record);
  const declared = meta.defaults || {};
  for (const field of Object.keys(declared)) {
    if (value[field] === undefined) value[field] = declared[field];
  }
  return value;
}

// A field declared optional may simply have no value, and a store that never
// received one said so in two ways: kv kept no key at all (JSON drops
// undefined), while a nullable column read back as NULL, so one fetch answered
// two shapes per driver. Every record that is read (fetch or find) now names
// every declared column, with null where it has no value; a default still wins
// because both reads run withDefaults first (find used to skip it). The insert response is untouched: it is the
// record the body handed over, and both drivers answer it the same.
function fillDeclared(meta, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const value = Object.assign({}, record);
  for (const column of meta.columns) {
    if (value[column.name] === undefined) value[column.name] = null;
  }
  return value;
}

__STREAM_SOURCE__

// ---------- http ----------

function send(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, name, values) {
  const info = ERRORS[name] || { status: 500, message: 'internal error', fields: [] };
  // An Internal error may carry one sentence about what went wrong inside the
  // service (an unknown entity, a missing adapter): it is ours, not the
  // caller's, so it is safe to echo and it is the only clue the client gets.
  // An Internal error carries the sentence about what broke inside; Invalid
  // carries the field the caller forgot (insert Room: missing id). Both are
  // written by us and are the only clue the client gets.
  const own = (name === 'Internal' || name === 'Invalid') && values && typeof values.message === 'string';
  const detail = own && values.message !== 'Internal' && values.message !== 'Invalid'
    ? values.message
    : info.message;
  const body = { error: name, message: detail };
  for (const field of info.fields || []) {
    const value = values && typeof values === 'object' ? values[field] : undefined;
    if (value !== undefined) body[field] = value;
  }
  send(res, info.status, JSON.stringify(body));
}

function matchRoute(method, pathname) {
  const found = findRoute(method, pathname);
  // RFC 9110: a HEAD response is the GET response without a body, and Node
  // already drops the body of a HEAD reply. Without the fallback every health
  // check and proxy probe (curl -I) on a declared GET route answered 404.
  if (!found && method === 'HEAD') return findRoute('GET', pathname);
  return found;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function findRoute(method, pathname) {
  const actual = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const expected = route.path.split('/').filter(Boolean);
    if (expected.length !== actual.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].startsWith(':')) {
        // A path with a malformed escape ("%zz") is a client mistake, not a
        // server fault: decodeURIComponent throws a URIError, which used to
        // escape the matcher, land in handleRequest's catch and answer 500 —
        // polluting the error rate with requests that are simply wrong.
        const decoded = safeDecode(actual[i]);
        if (decoded === null) { ok = false; break; }
        params[expected[i].slice(1)] = decoded;
      } else if (expected[i] !== actual[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { op: route.op, path: route.path, params };
  }
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// __HANDLERS_START__
async function handleCreate(req, res) {
  let raw;
  try {
    raw = await readBody(req, CONFIG.maxBody + 4096);
  } catch {
    return sendError(res, 'Invalid');
  }

  let body = raw;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw || '{}');
      body = typeof parsed.body === 'string' ? parsed.body : '';
    } catch {
      return sendError(res, 'Invalid');
    }
  }

  const size = Buffer.byteLength(body, 'utf8');
  if (size < CONFIG.minBody || size > CONFIG.maxBody) return sendError(res, 'Invalid');

  const id = randomUUID();
  await store.set('msg:' + id, body, CONFIG.ttlMs);
  send(res, 201, JSON.stringify({ id, expiresIn: Math.round(CONFIG.ttlMs / 1000) }));
}

async function handleRead(req, res, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return sendError(res, 'NotFound');
  }
  const result = await store.take('msg:' + id, 'gone:' + id, CONFIG.goneTtlMs, ATOMIC_READ);
  if (result.state === 'ok') return send(res, 200, result.value, 'text/plain; charset=utf-8');
  if (result.state === 'gone') return sendError(res, CONFIG.consumedError);
  return sendError(res, 'NotFound');
}
// __HANDLERS_END__

__QUEUE_SOURCE__

// ---------- http ----------

// The first screen is a parameterless GET, so it can be answered in-process:
// the handler writes into a capturing response and its JSON lands in the page.
// A failure is not fatal to the page: it ships without data and the client
// hydrates by fetching, exactly as a static page does.
async function pageWithData(page) {
  const marker = '__ARC_SSR_DATA__';
  if (!page.dataOp || page.html.indexOf(marker) < 0) return page.html;
  const handler = HANDLERS[page.dataOp];
  let data = null;
  if (handler) {
    try {
      let body = '';
      const capture = {
        statusCode: 200,
        setHeader() {},
        getHeader() { return undefined; },
        writeHead(status) { capture.statusCode = status; return capture; },
        end(chunk) { if (chunk) body += String(chunk); },
        on() {},
        once() {},
        destroy() {},
      };
      const fakeReq = { method: 'GET', url: page.route, headers: {}, on() {}, once() {}, destroy() {} };
      await handler(fakeReq, capture, {});
      if (capture.statusCode === 200 && body) data = JSON.parse(body);
    } catch (err) {
      console.error('ssr data failed:', err && err.message ? err.message : err);
    }
  }
  return page.html.replace(marker, () => JSON.stringify(data === undefined ? null : data).split('<').join('\\u003c'));
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const requestId = String(req.headers['x-request-id'] || '').slice(0, 128) || randomUUID();
  res.setHeader('x-request-id', requestId);
  requestCtx.run({ id: requestId, actor: null }, () => handleRequest(req, res, start));
});

async function handleRequest(req, res, start) {
  if (CONFIG.concurrency) {
    if (inFlight >= CONFIG.concurrency) {
      send(res, 503, JSON.stringify({ error: 'Unavailable', message: 'too many concurrent requests' }));
      metricError('unavailable');
      finish('unavailable', '', 503, start, req);
      return;
    }
    inFlight++;
    res.on('close', () => { inFlight--; });
  }

  let routeName = 'unknown';
  let opName = '';
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const page = PAGES.find((item) => item.route === url.pathname);
    if (page && (req.method === 'GET' || req.method === 'HEAD')) {
      const html = await pageWithData(page);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // The first screen is per-request data: a shared cache must not keep it.
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-length', Buffer.byteLength(html));
      res.end(req.method === 'HEAD' ? undefined : html);
      finish(page.route, '', 200, start, req);
      return;
    }
    // A probe and a scrape are reads: POST /healthz used to answer the probe
    // too, so a client that posted to the wrong URL saw a healthy 200 instead
    // of a 404. Only GET and HEAD are the probe's.
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        await store.ping();
        // The probe names the store it actually pinged: a sql service used to
        // answer kv: up, which reads as a healthy cache while the database
        // is the thing under test. kv keeps its key, a sql service says sql.
        const health = { status: 'ok', service: CONFIG.service };
        health[CONFIG.store] = 'up';
        send(res, 200, JSON.stringify(health));
        finish('/healthz', '', 200, start, req);
      } catch {
        const health = { status: 'degraded' };
        health[CONFIG.store] = 'down';
        send(res, 503, JSON.stringify(health));
        finish('/healthz', '', 503, start, req);
      }
      return;
    }

    if (url.pathname === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(res, 200, prometheusMetrics(), 'text/plain; version=0.0.4; charset=utf-8');
      finish('/metrics', '', 200, start, req);
      return;
    }

    const route = matchRoute(req.method || 'GET', url.pathname);
    if (!route) {
      send(res, 404, JSON.stringify({ error: 'NotFound', message: 'not found' }));
      finish('not_found', '', 404, start, req);
      return;
    }
    routeName = route.path;
    opName = route.op;
    const handler = HANDLERS[route.op];
    if (!handler) {
      send(res, 501, JSON.stringify({ error: 'NotImplemented', op: route.op }));
      finish(route.path, opName, 501, start, req);
      return;
    }

    await withSpan(opName || routeName, { route: route.path, method: req.method || 'GET' }, () => handler(req, res, route.params));
    finish(route.path, opName, res.statusCode, start, req);
  } catch (err) {
    // A 5xx is a bug or a model mistake, not an answer: the stack belongs in
    // the log, and only our own Internal message (which never carries user
    // data) is echoed to the client.
    console.error('request failed:', err && err.stack ? err.stack : err);
    const message = err instanceof ArcodError && err.error === 'Internal' && err.message ? err.message : 'internal error';
    send(res, 500, JSON.stringify({ error: 'Internal', message }));
    metricError(opName || routeName);
    finish(routeName, opName, 500, start, req);
  }
}

__STREAM_WIRE__

const PORT = Number(process.env.PORT || CONFIG.port);

__QUEUE_WIRE__

server.requestTimeout = Number(process.env.ARCod_TIMEOUT_MS || CONFIG.timeoutMs || 30000);
server.headersTimeout = server.requestTimeout + 5000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('arcod service ' + CONFIG.service + ' listening on :' + PORT);
});

__SHUTDOWN__
`;

const CRYPTO_IMPORT = "import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';";

// The store sources are standalone modules for their own tests; inside the
// service the net/crypto imports come from the template, so strip them and
// bind the single name the client needs.
function postgresSources(): string {
  const body = PG_STORE_SOURCE.split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n');
  return 'const pgConnect = net.connect;\n' + body + '\n' + PG_SQL_STORE_SOURCE;
}

// A bind that points at the host by name (`endpoint(url: "http://localhost:9096")`)
// is rewritten to `host.docker.internal`, which Docker Desktop resolves in both
// families. Node picks the AAAA record, the host listener is IPv4-only, and
// `fetch` fails with `fetch failed` while `wget` inside the same container
// answers (issue #42). The build asks for IPv4 first whenever it reaches the
// host by name; every other name keeps the runtime default.
function ipv4FirstPreamble(mod: ModuleNode): string {
  const byHost = mod.environments.some((env) => env.binds.some((bind) => {
    if (bind.provider !== 'endpoint') return false;
    const url = bind.args.url;
    if (!url || url.kind !== 'literal' || typeof url.value !== 'string') return false;
    return url.value.includes('localhost') || url.value.includes('127.0.0.1');
  }));
  if (!byHost) return '';
  return "import dns from 'node:dns';\ndns.setDefaultResultOrder('ipv4first');\n";
}

// The model names a capability; the generated adapter is whatever the
// environment can provision. kv gets a Redis client, sql a MySQL client.
function serviceTemplate(svc: ServiceNode, dialect: 'mysql' | 'postgres' = 'mysql'): string {
  if (storageKind(svc) === 'sql') {
    return streamSource(dropRedis(SERVICE_TEMPLATE), svc)
      .replace('__SQL_STORE__', () => (dialect === 'postgres' ? postgresSources() : SQL_STORE_SOURCE))
      .replace('__STORE_SELECT__', () => [
        // A build speaks one dialect: a mismatched DATABASE_URL is a config
        // error with a name, not a protocol error later.
        'function assertDialectUrl(url, expected) {',
        "  const scheme = String(url).split(':')[0].toLowerCase();",
        "  const ok = expected === 'postgres' ? (scheme === 'postgres' || scheme === 'postgresql') : scheme === 'mysql';",
        "  if (!ok) throw new Error('this build speaks ' + expected + ' but DATABASE_URL uses ' + scheme + '://');",
        '  return url;',
        '}',
        '',
        "const store = spannedStore(process.env.SQL_DRIVER === 'memory'",
        '  ? new MemoryStore()',
        dialect === 'postgres'
          ? "  : new PgStore(assertDialectUrl(process.env.DATABASE_URL || 'postgres://arcod:arcod@postgres:5432/arcod', 'postgres')), 'sql');"
          : "  : new SqlStore(assertDialectUrl(process.env.DATABASE_URL || 'mysql://arcod:arcod@mysql:3306/arcod', 'mysql')), 'sql');",
      ].join('\n'));
  }
  return streamSource(SERVICE_TEMPLATE, svc)
    .replace('__SQL_STORE__', () => '')
    .replace('__STORE_SELECT__', () => [
      "const store = spannedStore(process.env.KV_DRIVER === 'memory'",
      '  ? new MemoryStore()',
      "  : new RedisStore(process.env.KV_HOST || 'kv', Number(process.env.KV_PORT || 6379)), 'kv');",
    ].join('\n'));
}

// The hub is emitted only where someone can subscribe to it.
function streamSource(template: string, svc: ServiceNode): string {
  return template.replace('__STREAM_SOURCE__', () => (hasStream(svc) ? STREAM_SOURCE : ''));
}

export function hasStream(svc: ServiceNode | null): boolean {
  return Boolean(svc && svc.uses.some((use) => use.capability === 'stream' || use.capability.endsWith('.stream')));
}

export function hasQueue(svc: ServiceNode | null): boolean {
  return Boolean(svc && svc.uses.some((use) => use.capability === 'queue' || use.capability.endsWith('.queue')));
}

// An operation writes a fact and publishes an event in the same breath. On the
// sql driver the runtime wraps the body in a transaction and routes the publish
// through the outbox table, so the two commit or roll back together.
const STORE_WRITE_EFFECTS = new Set(['insert', 'set', 'update', 'remove', 'del', 'takeIf']);

function outboxActive(svc: ServiceNode): boolean {
  return storageKind(svc) === 'sql' && hasQueue(svc);
}

function outboxOps(svc: ServiceNode): Set<string> {
  const out = new Set<string>();
  if (storageKind(svc) !== 'sql' || !hasQueue(svc)) return out;
  const store = storageUse(svc)?.alias;
  const queue = svc.uses.find((use) => use.capability === 'queue' || use.capability.endsWith('.queue'))?.alias;
  if (!store || !queue) return out;
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const effects = op.clauses.find((clause) => clause.kind === 'effects');
    if (!effects || effects.kind !== 'effects') continue;
    const names = effects.names;
    const writes = names.some((name) => name === store + '.insert' || name === store + '.update' || name === store + '.remove' || name === store + '.set' || name === store + '.del' || name === store + '.takeIf');
    const publishes = names.some((name) => name === queue + '.publish');
    if (writes && publishes) out.add(op.name);
  }
  return out;
}

// A saga is a linear multi-step operation with compensation, executed by the
// runtime. Steps run in order; a failed step is retried, and on final failure
// the completed steps are compensated in reverse. Triggered by a job with
// 'saga: <name>'.
function sagaSource(svc: ServiceNode, impl: Record<string, string>): string {
  if (svc.sagas.length === 0) return '';
  const ownOps = svc.contract
    .filter((op) => op.kind === 'op' && impl[op.name])
    .map((op) => {
      const fn = 'impl' + op.name.charAt(0).toUpperCase() + op.name.slice(1);
      return '    ' + JSON.stringify(op.name) + ': ' + fn + ',';
    });
  const sagas = svc.sagas.map((saga) => {
    const steps = saga.steps.map((step) => [
      '      { name: ' + JSON.stringify(step.name) + ',',
      '        call: ' + JSON.stringify(step.call ?? '') + ',',
      '        compensate: ' + JSON.stringify(step.compensate ?? '') + ',',
      '        retry: ' + (step.retry ?? 0) + ' },',
    ].join('\n'));
    return [
      '  { name: ' + JSON.stringify(saga.name) + ', steps: [',
      steps.join('\n'),
      '  ] },',
    ].join('\n');
  });

  return [
    '',
    '// ---------- saga ----------',
    '',
    'const SAGAS = [',
    sagas.join('\n'),
    '];',
    '',
    'const OWN_OPS = {',
    ownOps.join('\n'),
    '};',
    '',
    'async function sagaInvoke(ref, input, io) {',
    "  if (ref.indexOf('.') >= 0) {",
    "    const parts = ref.split('.');",
    '    return await remoteCall(parts[0], parts[1], input);',
    '  }',
    '  const fn = OWN_OPS[ref];',
    "  if (!fn) throw new Error('saga: unknown own op ' + ref);",
    '  return await fn(input, io);',
    '}',
    '',
    'async function runSaga(name, input, io) {',
    '  const saga = SAGAS.find((s) => s.name === name);',
    "  if (!saga) throw new Error('saga: unknown saga ' + name);",
    '  const completed = [];',
    '  for (const step of saga.steps) {',
    '    const attempts = (step.retry == null ? 0 : step.retry) + 1;',
    '    let ok = false;',
    '    let lastError = null;',
    '    for (let attempt = 0; attempt < attempts; attempt++) {',
    '      try {',
    '        const out = await sagaInvoke(step.call, input, io);',
    "        if (out && out.error) throw new Error('saga step ' + step.name + ' returned ' + out.error);",
    '        ok = true;',
    '        break;',
    '      } catch (error) {',
    '        lastError = error;',
    '      }',
    '    }',
    '    if (!ok) {',
    '      // Compensate the completed steps in reverse order. Compensation is',
    '      // the terminal state of a failed saga: the message is not retried.',
    '      for (let i = completed.length - 1; i >= 0; i--) {',
    '        const done = completed[i];',
    '        if (!done.compensate) continue;',
    '        try {',
    '          await sagaInvoke(done.compensate, input, io);',
    "          metricCapability('saga.compensate.' + done.name);",
    '        } catch (error) {',
    "          console.error('saga compensation failed:', done.compensate, error && error.message ? error.message : error);",
    '        }',
    '      }',
    "      metricCapability('saga.' + name + '.compensated');",
    "      return { result: { status: 'compensated', step: step.name, error: String(lastError && lastError.message ? lastError.message : lastError) } };",
    '    }',
    '    completed.push(step);',
    '  }',
    "  metricCapability('saga.' + name);",
    "  return { result: { status: 'completed' } };",
    '}',
    '',
  ].join('\n');
}

// Queue drivers and consumers are emitted only in impl mode: reference and
// scaffold handlers are self-contained and never touch the io adapter.
function queueSourceFor(svc: ServiceNode, impl?: Record<string, string>): string {
  if (!hasQueue(svc) || !impl) return '';
  const consumers = svc.contract
    .filter((op) => op.kind === 'job')
    .flatMap((op) => {
      const consume = op.clauses.find((clause) => clause.kind === 'consume');
      if (!consume || consume.kind !== 'consume') return [];
      const retry = op.clauses.find((clause) => clause.kind === 'retry');
      const sagaClause = op.clauses.find((clause) => clause.kind === 'saga');
      const isSaga = sagaClause && sagaClause.kind === 'saga';
      if (!isSaga && !impl[op.name]) return [];
      return [{
        topic: consume.source.split('.').slice(1).join('.'),
        handler: isSaga
          ? '(input, io) => runSaga(' + JSON.stringify(sagaClause.name) + ', input, io)'
          : 'impl' + op.name.charAt(0).toUpperCase() + op.name.slice(1),
        params: op.params.map((param) => param.name),
        retry: retry && retry.kind === 'retry' ? retry.value : 3,
      }];
    });
  return sagaSource(svc, impl) + QUEUE_SOURCE + '\n' + consumerSource(consumers);
}

function dropRedis(template: string): string {
  const start = template.indexOf('// __REDIS_START__');
  const end = template.indexOf('// __REDIS_END__');
  if (start < 0 || end < start) return template;
  return template.slice(0, start) + template.slice(end + '// __REDIS_END__'.length);
}

function cryptoImportFor(svc: ServiceNode, withBodies: boolean, dialect: 'mysql' | 'postgres' = 'mysql'): string {
  const names = ['randomUUID'];
  // `hash` is a capability, not a property of a password body: a service that
  // declares `uses sig: hash` gets io.hash/io.verify whether or not any op
  // takes a password (issue #44).
  if (withBodies && (isGuarded(svc) || usesHashCapability(svc))) names.push('randomBytes', 'scryptSync', 'timingSafeEqual');
  if (storageKind(svc) === 'sql') names.push('constants', 'createHash', 'createPublicKey', 'publicEncrypt');
  if (hasStream(svc)) names.push('createHash');
  // SCRAM-SHA-256 needs HMAC and PBKDF2; the client only travels with a
  // postgres build. It also compares the server signature with
  // timingSafeEqual on every handshake, whether or not the service hashes
  // passwords itself: the name is a property of the wire client, not of the
  // guarded bodies.
  if (dialect === 'postgres') names.push('createHash', 'createHmac', 'pbkdf2Sync', 'randomBytes', 'timingSafeEqual');
  if (svc.uses.some((use) => use.capability === 'identity' || use.capability.endsWith('.identity'))) {
    names.push('createPublicKey', 'verify');
  }
  if (svc.uses.some((use) => use.capability === 'blob' || use.capability.endsWith('.blob'))) {
    names.push('createHash', 'createHmac');
  }
  return "import { " + [...new Set(names)].join(', ') + " } from 'node:crypto';";
}

export function emitService(mod: ModuleNode, options: EmitOptions = {}): string {
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to emit');
  const opNames = svc.contract.filter((op) => op.kind === 'op').map((op) => op.name);
  // The built-in template body covers exactly create/read and is spliced in
  // only in reference mode. Impl bodies come from the caller and the scaffold
  // emits TODO stubs, so neither mode needs a template.
  const reference = options.reference === true && !options.impl;
  const missing = opNames.filter((name) => !templateFor(name, isGuarded(svc)));
  if (reference && (!opNames.includes('create') || !opNames.includes('read') || missing.length > 0)) {
    throw new Error('emitter v0 has templates only for ' + Object.keys(HANDLER_TEMPLATES).join(', ') + '; got: ' + opNames.join(', '));
  }

  const ttlMs = storageTtlMs(svc);
  // The request-size ceiling comes from the operation that accepts a body:
  // create in the message examples, upload in the file service.
  const bodyOp = svc.contract.find((op) => op.name === 'create')
    ?? svc.contract.find((op) => op.kind === 'op' && op.params.some((param) => param.name === 'body'))
    ?? svc.contract.find((op) => op.kind === 'op');
  const limits = bodyLimits(mod, bodyOp!);
  const routes = svc.contract
    .filter((op) => op.kind === 'op')
    .map((op) => {
      const route = routeOf(op);
      if (!route) throw new Error('op ' + op.name + ' has no route');
      const parts = route.split(' ');
      // matchRoute compares against the uppercased request method, and check
      // accepts "post /v1/x" (A070 looks the method up case-insensitively).
      // Emitting the written casing made such a route answer 404 forever; the
      // remote client and OpenAPI already normalize the same way.
      return { method: (parts[0] ?? 'GET').toUpperCase(), path: parts[1], op: op.name };
    });

  // An error may declare payload fields (error Conflict { fence: int }). The
  // response echoes the declared names only, so a body cannot smuggle extra
  // properties into the error document.
  const errorFields: Record<string, string[]> = {};
  for (const decl of mod.errors) {
    if (decl.fields.length > 0) errorFields[decl.name] = decl.fields.map((field) => field.name);
  }
  const errors: Record<string, { status: number; message: string; fields: string[] }> = {};
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind !== 'errors') continue;
      for (const name of clause.names) errors[name] = { ...errorInfo(name), fields: errorFields[name] ?? [] };
    }
  }

  const config = {
    service: svc.name,
    module: mod.name + '@' + mod.version,
    port: options.port ?? 3000,
    ttlMs,
    goneTtlMs: ttlMs,
    minBody: limits.min,
    maxBody: limits.max,
    concurrency: budgetConcurrency(svc),
    timeoutMs: 30000,
    store: storageKind(svc),
    consumedError: consumedErrorName(svc) ?? (errors.Gone ? 'Gone' : 'NotFound'),
  };

  const readOp = svc.contract.find((op) => op.name === 'read');
  const atomicRead = Boolean(readOp && svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === readOp.name));

  const DEFAULT_SHUTDOWN = `for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}`;

  const externals = mod.services.filter((item) => item.external);
  const plugins = pluginBindings(mod, options.registry);
  const template = withHandlers(serviceTemplate(svc, options.dialect), reference, svc, options.impl, externals, mod, plugins, options.implLib)
    .replace(CRYPTO_IMPORT, () => cryptoImportFor(svc, reference || Boolean(options.impl), options.dialect))
    .replace('const CONFIG = __CONFIG__;', () => ipv4FirstPreamble(mod) + 'const CONFIG = __CONFIG__;')
    .replace('__QUEUE_SOURCE__\n', () => queueSourceFor(svc, options.impl) + (outboxActive(svc) && options.impl ? outboxSource(options.dialect) + '\n' : ''))
    .replace('__QUEUE_WIRE__', () => (hasQueue(svc) && options.impl ? (outboxActive(svc) ? 'startOutboxDispatcher();\n' : '') + 'startConsumers();\n' : ''))
    .replace('__SHUTDOWN__', () => (outboxActive(svc) && options.impl ? OUTBOX_SHUTDOWN : hasQueue(svc) && options.impl ? QUEUE_SHUTDOWN : DEFAULT_SHUTDOWN));
  const header = [
    '// Generated by arcod from ' + mod.name + '@' + mod.version + ' (' + svc.name + '). Do not edit.',
    '// Routes, limits, errors and rules come from the model.',
    options.impl
      ? '// Mode: impl. Operation bodies come from impl/ and are called through the io adapter.'
      : reference
        ? '// Mode: reference implementation. Operation bodies are built-in templates (' + opNames.map((name) => name + '=' + templateFor(name, isGuarded(svc))).join(', ') + '), not derived from the model.'
        : '// Mode: scaffold. Operation bodies are TODO; implement them according to the contract.',
    '',
  ].join('\n');

  // Same entity set as the migrations: a DTO the bodies never store has no
  // table and no store entry, so the schema and the runtime cannot disagree.
  const declaredRecords = mod.types.filter((decl) => decl.type.kind === 'record').map((decl) => decl.name);
  const entities = entitiesFromBodies(options.impl, declaredRecords);
  const stores = storageKind(svc) === 'sql' ? sqlEntityStores(mod, svc, entities) : entityStores(mod, svc, entities);

  return header + template
    .replace('__CONFIG__', () => JSON.stringify(config, null, 2))
    .replace('__STORES__', () => JSON.stringify(stores, null, 2))
    .replace('__MIGRATIONS__', () => JSON.stringify(migrationPlan(mod, svc, { dialect: dialectNamed(options.dialect), entities }).migrations))
    .replace('__ROUTES__', () => JSON.stringify(routes, null, 2))
    .replace('__PAGES__', () => JSON.stringify(options.pages ?? []))
    .replace('__ERRORS__', () => JSON.stringify(errors, null, 2))
    .replace('__ATOMIC__', () => String(atomicRead))
    .replace('__STREAM_WIRE__', hasStream(svc)
      ? "server.on('upgrade', (req, socket, head) => wsUpgrade(req, socket, head));"
      : '')
    .replace('__PLUGIN_WIRE__', () => pluginWireSource(plugins));
}

function withHandlers(template: string, reference: boolean, svc: ServiceNode, impl: Record<string, string> | undefined, externals: ServiceNode[], mod: ModuleNode, plugins: PluginBinding[] = [], implLib?: string): string {
  const startMarker = '// __HANDLERS_START__';
  const endMarker = '// __HANDLERS_END__';
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error('handler markers are missing in the service template');

  const before = template.slice(0, start);
  const body = template.slice(start + startMarker.length, end);
  const after = template.slice(end + endMarker.length);

  const hashing = isGuarded(svc);

  if (impl) {
    const handlers = implHandlers(svc, impl, hashing || usesHashCapability(svc), externals, mod, plugins, implLib);
    return before + handlers + after;
  }

  if (reference) {
    const handlers = hashing ? guardedHandlers(svc) : body;
    const names = svc.contract.filter((op) => op.kind === 'op').map((op) => op.name);
    const table = [
      'const HANDLERS = {',
      ...names.map((name) => {
        const fn = 'handle' + name.charAt(0).toUpperCase() + name.slice(1);
        const id = name === 'read' ? ', params.id' : '';
        return '  ' + name + ': (req, res, params) => ' + fn + '(req, res' + id + '),';
      }),
      '};',
      '',
    ].join('\n');
    return before + handlers + table + after;
  }
  return before + scaffoldHandlers(svc) + after;
}

// A guarded service is one that accepts a password and verifies it before
// revealing the payload. Reference mode ships this body; it is still a
// template, flagged by W018 in the same way as the plain one.
// The `hash` capability is served by the compiler itself under the `local`
// binding: scrypt with a per-call salt. check (A068) already allows it, so the
// runtime has to answer it too, guarded body or not.
export function usesHashCapability(svc: ServiceNode): boolean {
  return svc.uses.some((use) => use.capability === 'hash' || use.capability.endsWith('.hash'));
}

export function isGuarded(svc: ServiceNode): boolean {
  return svc.contract.some(
    (op) =>
      op.kind === 'op' &&
      op.params.some((param) => param.name === 'password' || namedType(param.type) === 'Password'),
  );
}

function namedType(type: TypeExpr): string | null {
  let current = type;
  while (current.kind === 'optional') current = current.inner;
  return current.kind === 'named' ? current.name : null;
}

function guardedHandlers(svc: ServiceNode): string {
  const names = svc.contract.filter((op) => op.kind === 'op').map((op) => op.name);
  const parts: string[] = [
    'function hashPassword(password) {',
    '  const salt = randomBytes(16);',
    '  const hash = scryptSync(password, salt, 32);',
    "  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');",
    '}',
    '',
    'function verifyPassword(password, stored) {',
    "  const parts = String(stored || '').split('$');",
    "  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;",
    "  const salt = Buffer.from(parts[1], 'hex');",
    "  const expected = Buffer.from(parts[2], 'hex');",
    '  if (salt.length === 0 || expected.length === 0) return false;',
    "  const actual = scryptSync(String(password || ''), salt, expected.length);",
    '  return actual.length === expected.length && timingSafeEqual(actual, expected);',
    '}',
    '',
  ];

  if (names.includes('create')) {
    parts.push(
      'async function handleCreate(req, res) {',
      '  let raw;',
      '  try {',
      '    raw = await readBody(req, CONFIG.maxBody + 4096);',
      '  } catch {',
      "    return sendError(res, 'Invalid');",
      '  }',
      '',
      '  let body = raw;',
      "  let password = '';",
      "  const type = String(req.headers['content-type'] || '');",
      "  if (type.includes('application/json')) {",
      '    try {',
      "      const parsed = JSON.parse(raw || '{}');",
      "      body = typeof parsed.body === 'string' ? parsed.body : '';",
      "      password = typeof parsed.password === 'string' ? parsed.password : '';",
      '    } catch {',
      "      return sendError(res, 'Invalid');",
      '    }',
      '  }',
      '',
      "  const size = Buffer.byteLength(body, 'utf8');",
      '  if (size < CONFIG.minBody || size > CONFIG.maxBody) {',
      "    return sendError(res, 'Invalid');",
      '  }',
      '',
      '  const record = JSON.stringify({ b: body, h: password ? hashPassword(password) : null });',
      '  const id = randomUUID();',
      "  await store.set('msg:' + id, record, CONFIG.ttlMs);",
      "  send(res, 201, JSON.stringify({ id }), 'application/json');",
      '}',
      '',
    );
  }

  if (names.includes('read')) {
    parts.push(
      'async function handleRead(req, res, id) {',
      '  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {',
      "    return sendError(res, 'NotFound');",
      '  }',
      '',
      "  const key = 'msg:' + id;",
      '  const stored = await store.get(key);',
      '  if (stored == null) {',
      "    const consumed = await store.exists('gone:' + id);",
      "    return sendError(res, consumed ? CONFIG.consumedError : 'NotFound');",
      '  }',
      '',
      '  let record;',
      "  try { record = JSON.parse(stored); } catch { record = { b: stored, h: null }; }",
      "  if (typeof record.b !== 'string') record = { b: stored, h: null };",
      '',
      '  if (record.h) {',
      "    const url = new URL(req.url || '/', 'http://localhost');",
      "    const provided = url.searchParams.get('password') || String(req.headers['x-password'] || '');",
      "    if (!verifyPassword(provided, record.h)) return sendError(res, 'WrongPassword');",
      '  }',
      '',
      "  const taken = await store.takeIf(key, 'gone:' + id, CONFIG.goneTtlMs, stored);",
      "  if (!taken) return sendError(res, CONFIG.consumedError);",
      "  send(res, 200, record.b, 'text/plain; charset=utf-8');",
      '}',
      '',
    );
  }

  return parts.join('\n');
}

// Entity methods for the sql driver: records live in typed tables, so the io
// surface delegates to the store's typed operations. Unique is the table's
// UNIQUE KEY (a duplicate is the declared Conflict), find is pushed into SQL.
// Entity methods for the kv driver: records live under meta.prefix, so
// count/find/aggregate scan that prefix and filter in memory. The scan applies
// declared defaults first: a row that predates a field must match `where` on
// that field and count in a sum, exactly as fetch and find present it.
function kvEntityIoLines(): string[] {
  return [
    '    async count(entity, query) {',
    '      metricCapability("store.count");',
    '      const meta = requestEntity(entity);',
    '      const opts = query || {};',
    '      if (opts.where) checkWhereFields(meta, opts.where);',
    '      const rows = await store.scan(meta.prefix);',
    '      let items = rows.map((row) => withDefaults(meta, recordOf(row.value)));',
    '      if (opts.where) items = items.filter((item) => matchesWhere(item, opts.where));',
    '      return items.length;',
    '    },',
    '    async aggregate(entity, query) {',
    '      metricCapability("store.aggregate");',
    '      const meta = requestEntity(entity);',
    '      const opts = query || {};',
    '      if (opts.where) checkWhereFields(meta, opts.where);',
    '      const field = String(opts.field || "");',
    '      const op = String(opts.op || "");',
    '      if (op !== "sum" && op !== "avg" && op !== "min" && op !== "max") {',
    '        throw new ArcodError("Invalid", { message: "aggregate: unknown op \\"" + op + "\\"; use sum, avg, min or max" });',
    '      }',
    '      const column = meta.columns.find((item) => item.name === field);',
    '      if (!column) {',
    '        throw new ArcodError("Invalid", { message: "aggregate: unknown field \\"" + field + "\\"" });',
    '      }',
    '      if (!["int", "float", "number", "decimal"].includes(column.base)) {',
    '        throw new ArcodError("Invalid", { message: "aggregate: field " + JSON.stringify(field) + " is not numeric" });',
    '      }',
    '      const rows = await store.scan(meta.prefix);',
    '      let items = rows.map((row) => withDefaults(meta, recordOf(row.value)));',
    '      if (opts.where) items = items.filter((item) => matchesWhere(item, opts.where));',
    '      let total = 0; let seen = 0; let best = null;',
    '      for (const item of items) {',
    '        const raw = item && typeof item === "object" ? item[field] : null;',
    '        if (raw == null) continue;',
    '        const number = Number(raw);',
    '        if (!Number.isFinite(number)) throw new ArcodError("Invalid", { message: "aggregate: field \\"" + field + "\\" is not numeric" });',
    '        seen += 1; total += number;',
    '        if (best == null || (op === "min" ? number < best : op === "max" ? number > best : false)) best = number;',
    '      }',
    '      if (op === "sum") return total;',
    '      if (seen === 0) return null;',
    '      if (op === "avg") return total / seen;',
    '      return best;',
    '    },',
    '    async fetch(entity, id) {',
    '      metricCapability("store.fetch");',
    '      const meta = requestEntity(entity);',
    "      const raw = await store.get(meta.prefix + String(id));",
    '      return raw == null ? null : fillDeclared(meta, withDefaults(meta, recordOf(raw)));',
    '    },',
    '    async insert(entity, record) {',
    '      metricCapability("store.insert");',
    '      const meta = requestEntity(entity);',
    "      if (record == null || typeof record !== \"object\" || Array.isArray(record)) throw new ArcodError('Invalid', { message: 'insert ' + entity + ': the record must be an object' });",
    '      const value = withDefaults(meta, record);',
    "      if (value.id == null || value.id === '') throw new ArcodError('Invalid', { message: 'insert ' + entity + ': missing id' });",
    '      checkRecordFields(meta, value, "insert " + entity);',
    "      const key = meta.prefix + String(value.id);",
    "      if (await store.exists(key)) throw new ArcodError('Conflict');",
    '      const claimed = [];',
    '      for (const group of meta.uniqueGroups) {',
    '        const values = group.map((field) => value[field]);',
    '        if (values.some((item) => item == null)) continue;',
    "        const claim = uniqueKey(entity, group.join(','), values);",
    '        if (!(await store.claim(claim))) {',
    '          for (const item of claimed) await store.del(item);',
    "          throw new ArcodError('Conflict');",
    '        }',
    '        claimed.push(claim);',
    '      }',
    '      await store.set(key, JSON.stringify({ b: value, h: null }), CONFIG.ttlMs);',
    '      return value;',
    '    },',
    '    async update(entity, id, patch) {',
    '      metricCapability("store.update");',
    '      const meta = requestEntity(entity);',
    '      checkRecordFields(meta, patch, "update " + entity);',
    '      checkUpdateKey(entity, id, patch);',
    '      const key = meta.prefix + String(id);',
    '      const raw = await store.get(key);',
    "      if (raw == null) throw new ArcodError('NotFound');",
    '      const current = recordOf(raw);',
    '      const base = current && typeof current === "object" ? current : {};',
    '      const value = Object.assign({}, base, patch || {});',
    '      if (value.id == null) value.id = id;',
    '      const claimed = [];',
    '      const released = [];',
    '      for (const group of meta.uniqueGroups) {',
    '        const before = group.map((field) => base[field]);',
    '        const after = group.map((field) => value[field]);',
    '        if (JSON.stringify(before) === JSON.stringify(after)) continue;',
    '        // Giving a value up is its own step. A clear to NULL must release the',
    '        // claim even though NULL itself is never claimed: skipping the group',
    '        // before the release kept the old value held forever, so the row no',
    '        // longer carried it and nobody could take it.',
    '        if (before.every((item) => item != null)) released.push(uniqueKey(entity, group.join(','), before));',
    '        if (after.some((item) => item == null)) continue;',
    "        const claim = uniqueKey(entity, group.join(','), after);",
    '        if (!(await store.claim(claim))) {',
    '          for (const item of claimed) await store.del(item);',
    "          throw new ArcodError('Conflict');",
    '        }',
    '        claimed.push(claim);',
    '      }',
    '      await store.set(key, JSON.stringify({ b: value, h: null }), CONFIG.ttlMs);',
    '      for (const item of released) await store.del(item);',
    '      return fillDeclared(meta, value);',
    '    },',
    '    async remove(entity, id) {',
    '      metricCapability("store.remove");',
    '      const meta = requestEntity(entity);',
    '      const key = meta.prefix + String(id);',
    '      const raw = await store.get(key);',
    '      if (raw == null) return false;',
    '      const current = recordOf(raw);',
    '      await store.del(key);',
    '      for (const group of meta.uniqueGroups) {',
    '        const values = group.map((field) => current && current[field]);',
    '        if (values.some((item) => item == null)) continue;',
    "        await store.del(uniqueKey(entity, group.join(','), values));",
    '      }',
    '      return true;',
    '    },',
    '    async find(entity, query) {',
    '      metricCapability("store.find");',
    '      const meta = requestEntity(entity);',
    '      const opts = query || {};',
    '      if (opts.where) checkWhereFields(meta, opts.where);',
    '      const requested = Number(opts.limit);',
    '      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;',
    '      const order = parseOrder(opts.order);',
    '      checkOrderFields(meta, order);',
    '      const rows = await store.scan(meta.prefix);',
    '      let items = rows.map((row) => ({ id: row.key.slice(meta.prefix.length), value: withDefaults(meta, recordOf(row.value)) }));',
    '      if (opts.where) items = items.filter((item) => matchesWhere(item.value, opts.where));',
    '      items.sort((left, right) => {',
    '        for (const rule of order) {',
    '          const a = left.value && typeof left.value === "object" ? sortValue(left.value[rule.field]) : null;',
    '          const b = right.value && typeof right.value === "object" ? sortValue(right.value[rule.field]) : null;',
    '          const diff = compareValues(a, b);',
    '          if (diff !== 0) return diff * rule.dir;',
    '        }',
    '        return compareValues(left.id, right.id);',
    '      });',
    '      if (opts.cursor) {',
    '        const at = decodeCursor(opts.cursor);',
    '        // A cursor from another order (or a corrupt one) used to vanish',
    '        // as if it were none: the page started over and a client that',
    '        // follows next looped forever. The shape is checked here too.',
    '        if (!at || !Array.isArray(at.v) || at.v.length !== order.length) {',
    "          throw new ArcodError('Invalid', {",
    "            message: 'cursor: not a page of this order (expected ' + order.length + ' sort value' + (order.length === 1 ? '' : 's') + '); ask for the first page with this order',",
    '          });',
    '        }',
    '        if (at.s && at.s !== "kv") {',
    "          throw new ArcodError('Invalid', { message: 'cursor: issued by the ' + at.s + ' store; ask for the first page here' });",
    '        }',
    '        const after = (item) => {',
    '          for (let index = 0; index < order.length; index++) {',
    '            const rule = order[index];',
    '            const value = item.value && typeof item.value === "object" ? sortValue(item.value[rule.field]) : null;',
    '            const diff = compareValues(value, at.v[index]);',
    '            if (diff !== 0) return diff * rule.dir;',
    '          }',
    '          return compareValues(item.id, at.id);',
    '        };',
    '        items = items.filter((item) => after(item) > 0);',
    '      }',
    '      const page = items.slice(0, limit);',
    '      const tail = page[page.length - 1];',
    '      const next = items.length > limit && tail',
    '        ? encodeCursor(order.map((rule) => (tail.value && typeof tail.value === "object" ? sortValue(tail.value[rule.field]) : null)), tail.id, "kv")',
    '        : null;',
    '      return {',
    '        items: page.map((item) => (item.value && typeof item.value === "object" && !Array.isArray(item.value) ? fillDeclared(meta, withDefaults(meta, Object.assign({ id: item.id }, item.value))) : item.value)),',
    '        next,',
    '      };',
    '    },',
  ];
}
function sqlEntityIoLines(): string[] {
  return [
    '    async fetch(entity, id) {',
    '      metricCapability("store.fetch");',
    '      const meta = requestEntity(entity);',
    '      const found = await store.entityFetch(meta.table, meta.columns, id);',
    '      return found == null ? null : fillDeclared(meta, withDefaults(meta, found));',
    '    },',
    '    async insert(entity, record) {',
    '      metricCapability("store.insert");',
    '      const meta = requestEntity(entity);',
    "      if (record == null || typeof record !== \"object\" || Array.isArray(record)) throw new ArcodError('Invalid', { message: 'insert ' + entity + ': the record must be an object' });",
    '      const value = withDefaults(meta, record);',
    "      if (value.id == null || value.id === '') throw new ArcodError('Invalid', { message: 'insert ' + entity + ': missing id' });",
    '      checkRecordFields(meta, value, "insert " + entity);',
    '      await store.entityInsert(meta.table, meta.columns, value, meta.uniqueGroups);',
    '      return value;',
    '    },',
    '    async update(entity, id, patch) {',
    '      metricCapability("store.update");',
    '      const meta = requestEntity(entity);',
    '      checkRecordFields(meta, patch, "update " + entity);',
    '      checkUpdateKey(entity, id, patch);',
    '      return fillDeclared(meta, await store.entityUpdate(meta.table, meta.columns, id, patch, meta.uniqueGroups));',
    '    },',
    '    async remove(entity, id) {',
    '      metricCapability("store.remove");',
    '      const meta = requestEntity(entity);',
    '      const removed = await store.entityRemove(meta.table, meta.columns, id, meta.uniqueGroups);',
    '      return removed > 0;',
    '    },',
    '    async find(entity, query) {',
    '      metricCapability("store.find");',
    '      const meta = requestEntity(entity);',
    '      if (query && query.where) checkWhereFields(meta, query.where);',
    '      const page = await store.entityFind(meta.table, meta.columns, query);',
    '      return { items: page.items.map((item) => fillDeclared(meta, withDefaults(meta, item))), next: page.next };',
    '    },',
    '    async count(entity, query) {',
    '      metricCapability("store.count");',
    '      const meta = requestEntity(entity);',
    '      if (query && query.where) checkWhereFields(meta, query.where);',
    '      return await store.entityCount(meta.table, meta.columns, query);',
    '    },',
    '    async aggregate(entity, query) {',
    '      metricCapability("store.aggregate");',
    '      const meta = requestEntity(entity);',
    '      if (query && query.where) checkWhereFields(meta, query.where);',
    '      return await store.entityAggregate(meta.table, meta.columns, query);',
    '    },',
  ];
}

function implHandlers(
  svc: ServiceNode,
  impl: Record<string, string>,
  guarded: boolean,
  externals: ServiceNode[],
  mod: ModuleNode,
  plugins: PluginBinding[],
  implLib?: string,
): string {
  const bodies = svc.contract.filter((op) => impl[op.name]);
  const ops = bodies.filter((op) => op.kind === 'op');
  const names = bodies.map((op) => op.name);
  const parts: string[] = [];

  // Constrained scalars (email/url/enum) are checked at the boundary, before
  // the body runs: a client mistake is a 400 with the field named, never a
  // TypeError deep inside an operation that turns into a 500.
  const constraints: Record<string, Record<string, { format?: string; enum?: string[]; min?: number; max?: number }>> = {};
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const table = constraintTable(mod, op.params);
    if (Object.keys(table).length > 0) constraints[op.name] = table;
  }
  parts.push(
    'const CONSTRAINTS = ' + JSON.stringify(constraints, null, 2) + ';',
    '',
    'function validateInput(op, input) {',
    '  const spec = CONSTRAINTS[op];',
    '  if (!spec) return null;',
    '  for (const name of Object.keys(spec)) {',
    '    const rule = spec[name];',
    '    const value = input[name];',
    '    if (value === null || value === undefined) continue;',
    '    if (rule.enum) {',
    '      if (!rule.enum.includes(String(value))) return name + " must be one of " + rule.enum.join(", ");',
    '      continue;',
    '    }',
    '    if (rule.min !== undefined || rule.max !== undefined) {',
    '      const number = typeof value === "number" ? value : Number(value);',
    '      if (rule.integer && !Number.isInteger(number)) return name + " must be an integer";',
    '      if (!rule.integer && !Number.isFinite(number)) return name + " must be a number";',
    '      if (rule.min !== undefined && number < rule.min) return name + " must be >= " + rule.min;',
    '      if (rule.max !== undefined && number > rule.max) return name + " must be <= " + rule.max;',
    '      continue;',
    '    }',
    '    if (rule.minLength !== undefined || rule.maxLength !== undefined) {',
    '      const length = typeof value === "string" ? (rule.unit === "bytes" ? Buffer.byteLength(value, "utf8") : [...value].length) : -1;',
    '      const unit = rule.unit === "bytes" ? "bytes" : "characters";',
    '      if (length < 0) return name + " must be a string";',
    '      if (rule.minLength !== undefined && length < rule.minLength) return name + " must be at least " + rule.minLength + " " + unit;',
    '      if (rule.maxLength !== undefined && length > rule.maxLength) return name + " must be at most " + rule.maxLength + " " + unit;',
    '    }',
    '    if (rule.format === "email" && (typeof value !== "string" || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value))) return name + " must be an email";',
    '    if (rule.format === "uri" && (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:\\/\\/[^\\s]+$/i.test(value))) return name + " must be a url";',
    '  }',
    '  return null;',
    '}',
    '',
  );

  if (implLib) {
    // One copy for every body: a helper declared here is a top-level function
    // the bodies call, and the shared namespace is what A093 guards.
    parts.push('// impl/lib.mjs');
    parts.push(implLib.trim().replace(/^export\s+/gm, ''));
    parts.push('');
  }

  for (const name of names) {
    const source = impl[name];
    if (!source) continue;
    const fn = 'impl' + name.charAt(0).toUpperCase() + name.slice(1);
    const renamed = source
      .trim()
      .replace('export async function ' + name, 'async function ' + fn)
      .replace('export function ' + name, 'async function ' + fn)
      .replace(/^export\\s+/gm, '');
    parts.push('// impl/' + name + '.mjs');
    parts.push(renamed);
    parts.push('');
  }

  const hasIdentity = svc.uses.some((use) => use.capability === 'identity' || use.capability.endsWith('.identity'));
  const hasBlob = svc.uses.some((use) => use.capability === 'blob' || use.capability.endsWith('.blob'));
  const hasLlm = svc.uses.some((use) => use.capability === 'llm' || use.capability.endsWith('.llm'));
  const usesQueue = hasQueue(svc);

  if (hasIdentity) parts.push(IDENTITY_SOURCE);
  if (hasBlob) parts.push(BLOB_SOURCE);
  if (hasLlm) parts.push(LLM_SOURCE);
  if (externals.length > 0) parts.push(remoteSource(externals));

  parts.push(
    'function makeIo(req) {',
    '  let actorPromise = null;',
    '  return {',
    '    async load(id) {',
    "      const raw = await store.get('msg:' + id);",
    '      if (raw == null) return null;',
    "      try { const rec = JSON.parse(raw); if (rec && typeof rec === 'object' && 'b' in rec) return rec; } catch {}",
    '      return { b: raw, h: null };',
    '    },',
    '    async save(id, record) {',
    "      const rec = { b: record ? record.b : null, h: record && record.h ? String(record.h) : null };",
    "      await store.set('msg:' + id, JSON.stringify(rec), CONFIG.ttlMs);",
    '    },',
    '    async del(id) {',
    "      await store.del('msg:' + id);",
    '    },',
    '    async has(id) {',
    "      return (await store.get('msg:' + id)) != null;",
    '    },',
    '    async seen(id) {',
    "      return await store.exists('gone:' + id);",
    '    },',
    '    async takeIf(id, record) {',
    '      const expected = JSON.stringify(record);',
    "      return await store.takeIf('msg:' + id, 'gone:' + id, CONFIG.goneTtlMs, expected);",
    '    },',
    '    new() { return randomUUID(); },',
    '    async scan() {',
    "      const items = await store.scan('msg:');",
    '      return items.map((item) => {',
    "        const id = item.key.slice('msg:'.length);",
    '        let body = item.value;',
    "        try { const rec = JSON.parse(item.value); if (rec && typeof rec === 'object' && 'b' in rec) body = rec.b; } catch (error) {}",
    '        return { id, b: body };',
    '      });',
    '    },',
  );

  // kv entity methods read through meta.prefix and scan that prefix; a sql
  // build has typed tables and its own methods (sqlEntityIoLines below), so
  // emitting both put dead, never-reached methods into every sql bundle.
  if (storageKind(svc) !== 'sql') parts.push(...kvEntityIoLines());

  if (storageKind(svc) === 'sql') {
    parts.push(...sqlEntityIoLines());
  }

  if (hasIdentity) {
    parts.push(
      '    async actor() {',
      '      if (!actorPromise) actorPromise = actorFrom(req);',
      '      const a = await actorPromise;',
      '      const c = requestCtx.getStore();',
      '      if (c && a && a.id) c.actor = a.id;',
      '      return a;',
      '    },',
      '    async users() { return listUsers(); },',
    );
  }

  if (hasLlm) {
    parts.push(
      '    async chat(messages, system) { return llmChat(messages, system); },',
      '    model() { return llmModel(); },',
      '    async embed(texts) { return llmEmbed(texts); },',
    );
  }

  if (hasStream(svc)) {
    parts.push('    async publish(topic, message) { return wsPublish(topic, message); },');
  }

  if (usesQueue) {
    // On the sql driver the publish goes through the outbox table (the body
    // runs in a transaction), so the event survives a crash between the fact
    // write and the broker hand-off. kv publishes straight to the broker.
    const outboxPublish = storageKind(svc) === 'sql'
      ? '    async queuePublish(topic, message) { return store.outboxAppend(randomUUID(), String(topic), JSON.stringify({ payload: message === undefined ? null : message, attempts: 0 })); },'
      : '    async queuePublish(topic, message) { return queuePublishDriver(String(topic), JSON.stringify({ payload: message === undefined ? null : message, attempts: 0 })); },';
    parts.push(
      outboxPublish,
      '    async queueDead(topic) { const items = await queueDeadDriver(String(topic)); return items.map((item) => { try { return JSON.parse(item); } catch { return item; } }); },',
    );
  }

  // A plugin capability has no built-in driver: each declared signature is
  // answered by the adapter the binding selected. The method name belongs to
  // the capability, never to the provider, so a body stays provider-agnostic.
  for (const binding of plugins) {
    const use = svc.uses.find((item) => pluginCapabilityName(item.capability) === pluginCapabilityName(binding.capability));
    if (!use) continue;
    for (const method of binding.methods) {
      const args = method.params.join(', ');
      parts.push(
        '    async ' + method.name + '(' + args + ') {',
        '      metricCapability(' + JSON.stringify(binding.capability + '.' + method.name) + ');',
        '      return await pluginAdapter(' + JSON.stringify(binding.provider) + ').' + method.name + '(' + args + ');',
        '    },',
      );
    }
  }

  if (externals.length > 0) {
    parts.push('    async remote(service, op, input) { return remoteCall(service, op, input); },');
  }

  if (hasBlob) {
    parts.push(
      "    async blobPut(id, value, type) { return blobPut('objects/' + id, value, type); },",
      "    async blobGet(id) { return blobGet('objects/' + id); },",
      "    async blobDelete(id) { return blobDelete('objects/' + id); },",
    );
  }

  if (guarded) {
    parts.push(
      '    async hash(password) { return hashPassword(String(password || "")); },',
      '    async verify(password, hash) { return verifyPassword(String(password || ""), String(hash || "")); },',
    );
  }

  parts.push('  };', '}', '');

  if (guarded) {
    parts.push(
      'function hashPassword(password) {',
      '  const salt = randomBytes(16);',
      '  const hash = scryptSync(password, salt, 32);',
      "  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');",
      '}',
      'function verifyPassword(password, stored) {',
      "  const parts = String(stored || '').split('$');",
      "  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;",
      "  const salt = Buffer.from(parts[1], 'hex');",
      "  const expected = Buffer.from(parts[2], 'hex');",
      '  if (salt.length === 0 || expected.length === 0) return false;',
      "  const actual = scryptSync(String(password || ''), salt, expected.length);",
      '  return actual.length === expected.length && timingSafeEqual(actual, expected);',
      '}',
      '',
    );
  }

  const missing = names.filter((name) => !impl[name]);
  if (missing.length > 0) {
    parts.push(
      'function notImplemented(res, op) {',
      "  send(res, 501, JSON.stringify({ error: 'NotImplemented', op, todo: 'implement ' + op + ' according to the .arc contract' }));",
      '}',
      '',
    );
  }

  // Access control, straight from the model: `auth` needs an actor (401),
  // `roles:` needs one of the token roles (403), `owner:` needs the record
  // loaded by the named parameter to belong to the actor (403; admins
  // bypass, a missing record is NotFound, never a leak). The guard runs
  // before the body, so bodies start past the 401/403 boundary.
  const authzTable: Record<string, { auth: boolean; roles: string[]; owner: string | null }> = {};
  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const roles = op.clauses.find((clause) => clause.kind === 'roles');
    const owner = op.clauses.find((clause) => clause.kind === 'owner');
    authzTable[op.name] = {
      auth: op.auth,
      roles: roles && roles.kind === 'roles' ? roles.names : [],
      owner: owner && owner.kind === 'owner' ? owner.param : null,
    };
  }
  parts.push(
    'const AUTHZ = ' + JSON.stringify(authzTable, null, 2) + ';',
    '',
    'const OUTBOX_OPS = new Set(' + JSON.stringify([...outboxOps(svc)]) + ');',
    '',
    'async function authorize(spec, io, input) {',
    '  if (!spec || (!spec.auth && spec.roles.length === 0 && !spec.owner)) return null;',
    '  const actor = await io.actor();',
    "  if (!actor) return 'Unauthorized';",
    '  if (spec.roles.length > 0 && !(actor.roles || []).some((role) => spec.roles.includes(role))) return ' + "'Forbidden';",
    '  if (spec.owner) {',
    '    const rec = await io.load(input[spec.owner]);',
    '    if (!rec || !rec.b) return ' + "'NotFound';",
    '    if (!actor.admin && rec.b.owner !== actor.id) return ' + "'Forbidden';",
    '  }',
    '  return null;',
    '}',
    '',
  );

  parts.push(
    'async function readInput(req, params, names) {',
    "  const url = new URL(req.url || '/', 'http://localhost');",
    '  const input = {};',
    '  for (const name of names) {',
    '    if (params && Object.prototype.hasOwnProperty.call(params, name)) { input[name] = params[name]; continue; }',
    '    const fromQuery = url.searchParams.get(name);',
    '    if (fromQuery !== null) input[name] = fromQuery;',
    '  }',
    '  const missing = names.filter((name) => !(name in input));',
    "  if (missing.length > 0 && (req.method || 'GET') !== 'GET') {",
    '    let raw;',
    "    try { raw = await readBody(req, CONFIG.maxBody + 4096); } catch { return { error: 'Invalid' }; }",
    "    const type = String(req.headers['content-type'] || '');",
    "    if (type.includes('application/json')) {",
    '      let parsed;',
    "      try { parsed = JSON.parse(raw || '{}'); } catch { return { error: 'Invalid' }; }",
    '      for (const name of missing) input[name] = parsed && name in parsed ? parsed[name] : null;',
    '    } else if (missing.length === 1) {',
    '      input[missing[0]] = raw;',
    '    } else {',
    "      return { error: 'Invalid' };",
    '    }',
    '  }',
    '  for (const name of names) if (!(name in input)) input[name] = null;',
    '  return input;',
    '}',
    '',
    'async function callImpl(req, res, params, implFn, names, status, opName) {',
    '  const input = await readInput(req, params, names);',
    '  if (input && input.error) return sendError(res, input.error);',
    '  const invalid = validateInput(opName, input);',
    '  if (invalid) return send(res, 400, JSON.stringify({ error: \'Invalid\', message: invalid }));',
    '  const io = makeIo(req);',
    '  const denied = await authorize(AUTHZ[opName], io, input);',
    '  if (denied) return sendError(res, denied);',
    '  const tx = OUTBOX_OPS.has(opName);',
    '  let out;',
    '  if (tx) await store.begin();',
    '  try {',
    '    out = await implFn(input, io);',
    '    if (tx) await store.commit();',
    '  } catch (error) {',
    '    if (tx) await store.rollback();',
    '    // The adapter raises named errors (Conflict from a unique index,',
    '    // Invalid from a missing key); they travel as the declared error.',
    '    if (error && error.error) return sendError(res, String(error.error), error.fields || error);',
    '    console.error(error);',
    "    return sendError(res, 'Internal');",
    '  }',
    '  if (out && out.error) return sendError(res, out.error, out);',
    "  if (!out) return sendError(res, 'Internal');",
    '  const result = out.result;',
    "  if (typeof result === 'string') {",
    "    if (status === 201) return send(res, status, JSON.stringify({ id: result, expiresIn: Math.round(CONFIG.ttlMs / 1000) }), 'application/json');",
    "    return send(res, status, result, 'text/plain; charset=utf-8');",
    '  }',
    "  return send(res, status, JSON.stringify(result === undefined ? null : result), 'application/json');",
    '}',
    '',
  );

  for (const op of ops) {
    const cap = op.name.charAt(0).toUpperCase() + op.name.slice(1);
    const names = op.params.map((param) => param.name);
    const route = op.clauses.find((clause) => clause.kind === 'route');
    const method = route && route.kind === 'route' ? route.value.split(' ')[0].toUpperCase() : 'GET';
    // A HEAD answer mirrors GET: 200, and Node drops the body.
    const status = method === 'GET' || method === 'HEAD' ? 200 : 201;
    parts.push(
      // The runtime owns handleRequest, and a spec may name an operation
      // anything: a bare 'handle' + Op would collide for `op request` and the
      // module would not even parse. Handlers carry the arcod prefix so the
      // generated names cannot meet a runtime name.
      'async function arcodHandle' + cap + '(req, res, params) {',
      "  return callImpl(req, res, params, impl" + cap + ', [' + names.map((name) => "'" + name + "'").join(', ') + '], ' + status + ", '" + op.name + "');",
      '}',
      '',
    );
  }

  parts.push('const HANDLERS = {');
  for (const op of ops) {
    parts.push('  ' + op.name + ': arcodHandle' + op.name.charAt(0).toUpperCase() + op.name.slice(1) + ',');
  }
  parts.push('};', '');

  return parts.join('\n');
}

// A client for services that are not ours: the contract gives the route, the
// environment gives the base URL. Bodies call io.remote and never build a URL.
function remoteSource(externals: ServiceNode[]): string {
  const table: Record<string, { method: string; path: string; env: string }> = {};
  for (const svc of externals) {
    for (const op of svc.contract) {
      if (op.kind !== 'op') continue;
      const route = routeOf(op) ?? '';
      const method = route.split(' ')[0] || 'GET';
      const path = route.split(' ').slice(1).join(' ') || '/' + op.name;
      table[svc.name + '.' + op.name] = { method: method.toUpperCase(), path, env: endpointEnv(svc.name) };
    }
  }
  return `// ---------- remote ----------

const REMOTE = ${JSON.stringify(table, null, 2)};

async function remoteCall(service, op, input) {
  const route = REMOTE[service + '.' + op];
  if (!route) throw new Error('remote: unknown operation ' + service + '.' + op);
  const base = String(process.env[route.env] || '').replace(/\\/+$/, '');
  if (!base) throw new Error('remote: ' + service + ' is not bound (' + route.env + ' is empty)');

  const values = input && typeof input === 'object' ? input : {};
  let path = route.path;
  const body = {};
  const query = new URLSearchParams();
  for (const key of Object.keys(values)) {
    // ':item' must not match the capture ':itemId' — the name has to end here.
    const capture = new RegExp(':' + key + '(?![A-Za-z0-9_])');
    if (capture.test(route.path)) {
      path = path.replace(new RegExp(capture.source, 'g'), () => encodeURIComponent(String(values[key])));
    } else if (route.method === 'GET' || route.method === 'DELETE' || route.method === 'HEAD') {
      query.append(key, String(values[key]));
    } else {
      body[key] = values[key];
    }
  }
  const url = base + path + (query.toString() ? '?' + query.toString() : '');
  // HEAD is a GET without a response body: parameters travel in the query and
  // the request carries no body, which undici refuses for GET/HEAD anyway.
  const init = { method: route.method, headers: {} };
  const ctx = requestCtx.getStore();
  if (ctx && ctx.id) init.headers['x-request-id'] = ctx.id;
  if (CONFIG.timeoutMs) init.signal = AbortSignal.timeout(CONFIG.timeoutMs);
  if (route.method !== 'GET' && route.method !== 'DELETE' && route.method !== 'HEAD') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  metricCapability('remote.' + service + '.' + op);
  const response = await withSpan('remote.' + service + '.' + op, { method: route.method, path: route.path }, () => fetch(url, init));
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (error) { data = raw; }
  if (!response.ok) throw new Error('remote: ' + service + '.' + op + ' failed: ' + response.status + ' ' + raw.slice(0, 200));
  return { status: response.status, body: data };
}
`;
}

function scaffoldHandlers(svc: ServiceNode): string {
  const lines: string[] = [
    'function notImplemented(res, op) {',
    "  send(res, 501, JSON.stringify({ error: 'NotImplemented', op, todo: 'implement ' + op + ' according to the .arc contract' }));",
    '}',
    '',
  ];

  for (const op of svc.contract) {
    if (op.kind !== 'op') continue;
    const route = routeOf(op) ?? '(no route)';
    const errors = op.clauses
      .filter((clause) => clause.kind === 'errors')
      .flatMap((clause) => (clause.kind === 'errors' ? clause.names : []))
      .join(', ') || 'none';

    lines.push('// TODO: implement ' + op.name);
    lines.push('// Contract: ' + route + '; errors: ' + errors);
    lines.push('');
  }

  lines.push('const HANDLERS = {};', '');

  return lines.join('\n');
}

export function consumedErrorName(svc: ServiceNode): string | null {
  for (const rule of svc.rules) {
    if (rule.kind !== 'invariant') continue;
    const once = asOnce(rule.expr);
    if (once?.elseName) return once.elseName;
  }
  return null;
}

export function budgetConcurrency(svc: ServiceNode): number | null {
  const item = svc.budget?.items.find((entry) => entry.key === 'concurrency');
  if (!item) return null;
  if (item.expr.kind === 'literal' && typeof item.expr.value === 'number') return item.expr.value;
  return null;
}

export function maxBodyBytes(mod: ModuleNode): number {
  const svc = pickService(mod);
  const create = svc?.contract.find((op) => op.name === 'create');
  if (!create) return 64 * 1024;
  return bodyLimits(mod, create).max;
}

// The declared defaults of one record, resolved once: the runtime insert and
// fetch apply exactly this map, so a default cannot drift from the DDL.
function entityDefaults(mod: ModuleNode, decl: TypeDecl): Record<string, DefaultValue> {
  const defaults: Record<string, DefaultValue> = {};
  if (decl.type.kind !== 'record') return defaults;
  for (const field of decl.type.fields) {
    const value = fieldDefault(mod, field);
    if (value !== undefined) defaults[field.name] = value;
  }
  return defaults;
}

type FieldBounds = { min?: number; max?: number; minLength?: number; maxLength?: number; integer?: boolean; bytes?: boolean };

// Declared bounds belong to the entity, not only to its OpenAPI schema: a row
// outside them is the row the contract promises clients never see. Both the kv
// and the sql facade read this table, so the two drivers reject the same value
// instead of one storing what the other refuses. A `bytes` field keeps its
// length bound too (`bytes(max: 64kb)` is maxLength 65536 in the schema), and
// the body limit (bodyLimits) still caps the whole request.
function entityBounds(mod: ModuleNode, decl: TypeDecl): Record<string, FieldBounds> {
  const bounds: Record<string, FieldBounds> = {};
  if (decl.type.kind !== 'record') return bounds;
  for (const field of decl.type.fields) {
    const entry: FieldBounds = {};
    const numeric = boundsOf(mod, field.type);
    if (numeric.min !== null || numeric.max !== null) {
      if (numeric.integer) entry.integer = true;
      if (numeric.min !== null) entry.min = numeric.min;
      if (numeric.max !== null) entry.max = numeric.max;
    }
    // A text field and a bytes field both declare a length, and the schema
    // publishes it for both; a bound only the schema knows is a promise the
    // store breaks on the next impl insert.
    const base = baseType(mod, field.type);
    if (base === 'string' || base === 'bytes') {
      const lengths = lengthBoundsOf(mod, field.type);
      if (lengths.min !== null) entry.minLength = lengths.min;
      if (lengths.max !== null) entry.maxLength = lengths.max;
      // A bytes bound counts bytes, not code points: a Cyrillic value of the
      // declared character count occupies twice the bytes the field promised.
      if (base === 'bytes') entry.bytes = true;
    }
    if (Object.keys(entry).length > 0) bounds[field.name] = entry;
  }
  return bounds;
}

// How many list/map wrappers sit above an instant, or -1 when the type is not
// a container of instants at all. list<datetime> is 1, map<list<Moment>>
// (Moment an alias) is 2. The count is the whole fact the runtime needs: JSON
// arrays and objects are walked generically, so list and map need no separate
// case, and a record or union inside a container is left as written.
function instantDepthOf(mod: ModuleNode, type: TypeExpr, depth = 0): number {
  if (depth > 8) return -1;
  if (type.kind === 'optional') return instantDepthOf(mod, type.inner, depth + 1);
  if (type.kind !== 'named') return -1;
  if (type.name === 'datetime') return 0;
  const decl = mod.types.find((item) => item.name === type.name);
  if (decl) return instantDepthOf(mod, decl.type, depth + 1);
  if (type.name !== 'list' && type.name !== 'map') return -1;
  // list<K> has one argument; map<K, V> has two and the instant lives in V,
  // so take the last type argument rather than the key type.
  const typed = type.args.filter((item) => item.isType);
  const arg = type.name === 'map' ? typed[typed.length - 1] : (typed[0] ?? type.args[0]);
  const inner = arg ? (arg.value as TypeExpr) : null;
  if (!inner || (inner.kind !== 'named' && inner.kind !== 'optional')) return -1;
  const rest = instantDepthOf(mod, inner, depth + 1);
  return rest < 0 ? -1 : rest + 1;
}

// Only containers are listed: a scalar datetime column already goes through
// canonicalDateTime, and listing it twice would be a second rule for one fact.
function entityInstants(mod: ModuleNode, decl: TypeDecl): Record<string, number> {
  const table: Record<string, number> = {};
  if (decl.type.kind !== 'record') return table;
  for (const field of decl.type.fields) {
    const depth = instantDepthOf(mod, field.type);
    if (depth > 0) table[field.name] = depth;
  }
  return table;
}

// A field's declared format (email or url), for the same reason as the enum
// members below: a record built inside a body never crosses the op boundary.
function entityFormats(mod: ModuleNode, decl: TypeDecl): Record<string, string> {
  const formats: Record<string, string> = {};
  if (decl.type.kind !== 'record') return formats;
  const table = constraintTable(mod, decl.type.fields);
  for (const field of Object.keys(table)) {
    const format = table[field].format;
    if (format) formats[field] = format;
  }
  return formats;
}

// An enum field's declared members, kept for the record check: the op boundary
// already validates an input, but a record built inside a body does not pass a
// boundary at all.
function entityEnums(mod: ModuleNode, decl: TypeDecl): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  if (decl.type.kind !== 'record') return enums;
  const table = constraintTable(mod, decl.type.fields);
  for (const field of Object.keys(table)) {
    const members = table[field].enum;
    if (members && members.length > 0) enums[field] = members;
  }
  return enums;
}

// A container field's declared shape, kept apart from the column: list<..>,
// map<..> and a named record all store as JSON, so the column type cannot tell
// an array from an object. The runtime record check reads this map.
type FieldShape = 'list' | 'map' | 'record';

function entityShapes(mod: ModuleNode, decl: TypeDecl): Record<string, FieldShape> {
  const shapes: Record<string, FieldShape> = {};
  if (decl.type.kind !== 'record') return shapes;
  for (const field of decl.type.fields) {
    let type = field.type;
    while (type.kind === 'optional') type = type.inner;
    if (type.kind === 'record') {
      shapes[field.name] = 'record';
      continue;
    }
    if (type.kind !== 'named') continue;
    if (type.name === 'list') shapes[field.name] = 'list';
    else if (type.name === 'map') shapes[field.name] = 'map';
    else {
      const target = mod.types.find((entry) => entry.name === type.name);
      if (target && target.type.kind === 'record') shapes[field.name] = 'record';
    }
  }
  return shapes;
}

function entityStores(mod: ModuleNode, svc: ServiceNode, entities: string[] | null = null): Record<string, { prefix: string; columns: Column[]; bounds: Record<string, FieldBounds>; instants: Record<string, number>; shapes: Record<string, FieldShape>; enums: Record<string, string[]>; formats: Record<string, string>; uniqueGroups: string[][]; defaults: Record<string, DefaultValue> }> {
  const table: Record<string, { prefix: string; columns: Column[]; bounds: Record<string, FieldBounds>; instants: Record<string, number>; shapes: Record<string, FieldShape>; enums: Record<string, string[]>; formats: Record<string, string>; uniqueGroups: string[][]; defaults: Record<string, DefaultValue> }> = {};
  const uniques: Array<[string, string[]]> = [];
  for (const rule of svc.rules) {
    if (rule.kind !== 'unique') continue;
    uniques.push([rule.path.split('.')[0], rule.fields]);
  }
  for (const decl of mod.types) {
    // Only record shapes are storable; aliases point at one. A DTO (no store
    // call names it) is not storable at all.
    if (decl.type.kind !== 'record') continue;
    if (entities !== null && !entities.includes(decl.name)) continue;
    const groups = uniques.filter(([entity]) => entity === decl.name).map(([, fields]) => fields);
    table[decl.name] = {
      prefix: decl.name.toLowerCase() + ':',
      // The kv facade validates an aggregate field against the entity shape,
      // exactly like the sql facade does: without the columns every
      // io.aggregate on kv died on `meta.columns.some` with a 500.
      columns: recordColumns(mod, decl, groups),
      bounds: entityBounds(mod, decl),
      instants: entityInstants(mod, decl),
      shapes: entityShapes(mod, decl),
      enums: entityEnums(mod, decl),
      formats: entityFormats(mod, decl),
      uniqueGroups: groups,
      defaults: entityDefaults(mod, decl),
    };
  }
  return table;
}

function sqlEntityStores(mod: ModuleNode, svc: ServiceNode, entities: string[] | null = null): Record<string, { table: string; columns: unknown[]; bounds: Record<string, FieldBounds>; instants: Record<string, number>; shapes: Record<string, FieldShape>; enums: Record<string, string[]>; formats: Record<string, string>; uniqueGroups: string[][]; defaults: Record<string, DefaultValue> }> {
  const table: Record<string, { table: string; columns: unknown[]; bounds: Record<string, FieldBounds>; instants: Record<string, number>; shapes: Record<string, FieldShape>; enums: Record<string, string[]>; formats: Record<string, string>; uniqueGroups: string[][]; defaults: Record<string, DefaultValue> }> = {};
  const uniquesByEntity: Record<string, string[][]> = {};
  for (const rule of svc.rules) {
    if (rule.kind !== 'unique') continue;
    (uniquesByEntity[rule.path.split('.')[0]] ??= []).push(rule.fields);
  }
  for (const decl of mod.types) {
    if (decl.type.kind !== 'record') continue;
    if (entities !== null && !entities.includes(decl.name)) continue;
    const groups = uniquesByEntity[decl.name] ?? [];
    table[decl.name] = {
      table: decl.name.toLowerCase(),
      columns: recordColumns(mod, decl, groups),
      bounds: entityBounds(mod, decl),
      instants: entityInstants(mod, decl),
      shapes: entityShapes(mod, decl),
      enums: entityEnums(mod, decl),
      formats: entityFormats(mod, decl),
      uniqueGroups: groups,
      defaults: entityDefaults(mod, decl),
    };
  }
  return table;
}

export function pickService(mod: ModuleNode): ServiceNode | null {
  return mod.services.find((svc) => !svc.external) ?? null;
}

export function routeOf(op: OpNode): string | null {
  const clause = op.clauses.find((c) => c.kind === 'route');
  return clause && clause.kind === 'route' ? clause.value : null;
}

function storageTtlMs(svc: ServiceNode): number {
  const kv = storageUse(svc);
  const ttl = kv?.params.ttl;
  if (!ttl) return 999000;
  if (ttl.kind === 'duration') return durationMs(ttl.value, ttl.unit);
  if (ttl.kind === 'literal' && typeof ttl.value === 'number') return ttl.value * 1000;
  return 999000;
}

export function durationMs(value: number, unit: string): number {
  const table: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (table[unit] ?? 1000);
}

function sizeBytes(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === 'kb') return value * 1024;
  if (normalized === 'mb') return value * 1024 * 1024;
  if (normalized === 'gb') return value * 1024 * 1024 * 1024;
  return value;
}

function bodyLimits(mod: ModuleNode, op: OpNode): { min: number; max: number } {
  const param = op.params[0];
  if (!param) return { min: 1, max: 64 * 1024 };
  const resolved = resolveType(mod, param.type);
  if (resolved.kind !== 'named' || resolved.name !== 'bytes') return { min: 1, max: 64 * 1024 };
  let min = 1;
  let max = 64 * 1024;
  for (const arg of resolved.args) {
    if (arg.name === 'min' && arg.value.kind === 'literal' && typeof arg.value.value === 'number') min = arg.value.value;
    if (arg.name === 'max') {
      if (arg.value.kind === 'literal' && typeof arg.value.value === 'number') max = arg.value.value;
      if (arg.value.kind === 'duration') max = sizeBytes(arg.value.value, arg.value.unit);
    }
  }
  return { min, max };
}

function resolveType(mod: ModuleNode, type: TypeExpr): TypeExpr {
  let current = type;
  for (let depth = 0; depth < 8; depth++) {
    if (current.kind !== 'named') return current;
    const named = current;
    const decl = mod.types.find((item) => item.name === named.name);
    if (!decl) return named;
    current = decl.type;
  }
  return current;
}

export function statusForError(name: string): number {
  return errorInfo(name).status;
}

// What `auth`, `roles:` and `owner:` mean to a caller. OpenAPI has no keyword
// for the last two and GraphQL has none for any, so both emitters publish these
// sentences; the wording lives here once, next to the status table they read.
export function accessNotes(op: OpNode): string[] {
  if (!op.auth) return [];
  const notes: string[] = [];
  const roles = op.clauses.find((clause) => clause.kind === 'roles');
  const owner = op.clauses.find((clause) => clause.kind === 'owner');
  if (roles && roles.kind === 'roles') notes.push('Requires one of the roles: ' + roles.names.join(', '));
  if (owner) notes.push('The record must belong to the caller');
  if (notes.length === 0) notes.push('Requires an authenticated actor');
  return notes;
}

function errorInfo(name: string): { status: number; message: string } {
  const table: Record<string, { status: number; message: string }> = {
    Invalid: { status: 400, message: 'invalid request' },
    Unauthorized: { status: 401, message: 'unauthorized' },
    Forbidden: { status: 403, message: 'forbidden' },
    WrongPassword: { status: 403, message: 'wrong password' },
    NotFound: { status: 404, message: 'not found' },
    Gone: { status: 410, message: 'already consumed' },
    Conflict: { status: 409, message: 'conflict' },
    RateLimited: { status: 429, message: 'too many requests' },
    Unavailable: { status: 503, message: 'temporarily unavailable' },
  };
  return table[name] ?? { status: 500, message: name };
}
