import type { ModuleNode, OpNode, ServiceNode, TypeExpr } from '../ast.ts';
import { asOnce } from '../check.ts';
import { HANDLER_TEMPLATES, templateFor } from '../templates.ts';
import { SQL_STORE_SOURCE } from './sql-store.ts';
import { IDENTITY_SOURCE } from './identity.ts';
import { BLOB_SOURCE } from './blob.ts';
import { LLM_SOURCE } from './llm.ts';
import { STREAM_SOURCE } from './stream.ts';
import { QUEUE_SOURCE, QUEUE_SHUTDOWN, OUTBOX_SHUTDOWN, OUTBOX_SOURCE, consumerSource } from './queue.ts';
import { storageKind, storageUse } from '../capabilities.ts';
import { endpointEnv } from '../providers.ts';
import { migrationPlan, recordColumns } from '../migrate.ts';

export interface EmitOptions {
  port?: number;
  reference?: boolean;
  impl?: Record<string, string>;
}

const SERVICE_TEMPLATE = `import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const CONFIG = __CONFIG__;
CONFIG.timeoutMs = Number(process.env.ARCod_TIMEOUT_MS || CONFIG.timeoutMs || 30000);
const ROUTES = __ROUTES__;
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
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.connecting = null;
        resolve();
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        this.connecting = null;
        reject(err);
      });
      socket.on('close', () => {
        this.socket = null;
      });
      this.socket = socket;
    });
    return this.connecting;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = parseReply(this.buffer, 0);
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
    return this.command('GET', key);
  }

  async del(key) {
    return this.command('DEL', key);
  }

  async set(key, value, ttlMs) {
    return this.command('SET', key, value, 'PX', String(ttlMs));
  }

  async get(key) {
    const value = await this.command('GET', key);
    return value == null ? null : String(value);
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

  async entityInsert(table, columns, record) {
    const value = Object.assign({}, record || {});
    if (value.id == null || value.id === '') throw new ArcodError('Invalid');
    const key = this.entityKey(table, value.id);
    if (await this.exists(key)) throw new ArcodError('Conflict');
    const claimed = [];
    for (const col of columns) {
      if (!col.unique) continue;
      const fieldValue = value[col.name];
      if (fieldValue == null) continue;
      const claim = uniqueKey(table, col.name, fieldValue);
      if (!(await this.claim(claim))) {
        for (const item of claimed) await this.del(item);
        throw new ArcodError('Conflict');
      }
      claimed.push(claim);
    }
    await this.set(key, JSON.stringify({ b: value, h: null }), Infinity);
    return value;
  }

  async entityUpdate(table, columns, id, patch) {
    const key = this.entityKey(table, id);
    const raw = await this.get(key);
    if (raw == null) throw new ArcodError('NotFound');
    const current = recordOf(raw);
    const base = current && typeof current === 'object' ? current : {};
    const value = Object.assign({}, base, patch || {}, { id: String(id) });
    const claimed = [];
    const released = [];
    for (const col of columns) {
      if (!col.unique) continue;
      const before = base[col.name];
      const after = value[col.name];
      if (String(before) === String(after)) continue;
      if (before != null) {
        await this.del(uniqueKey(table, col.name, before));
        released.push({ col, before });
      }
    }
    for (const col of columns) {
      if (!col.unique) continue;
      const before = base[col.name];
      const after = value[col.name];
      if (String(before) === String(after)) continue;
      if (after != null) {
        const claim = uniqueKey(table, col.name, after);
        if (!(await this.claim(claim))) {
          for (const item of claimed) await this.del(item);
          for (const rel of released) await this.claim(uniqueKey(table, rel.col.name, rel.before));
          throw new ArcodError('Conflict');
        }
        claimed.push(claim);
      }
    }
    await this.set(key, JSON.stringify({ b: value, h: null }), Infinity);
    return value;
  }

  async entityRemove(table, columns, id) {
    const key = this.entityKey(table, id);
    const raw = await this.get(key);
    if (raw == null) return false;
    const current = recordOf(raw);
    await this.del(key);
    for (const col of columns) {
      if (!col.unique) continue;
      const fieldValue = current && current[col.name];
      if (fieldValue != null) await this.del(uniqueKey(table, col.name, fieldValue));
    }
    return true;
  }

  async entityFind(table, columns, query) {
    const q = query || {};
    const requested = Number(q.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;
    const order = parseOrder(q.order);
    const prefix = 'tbl:' + table + ':';
    const rows = await this.scan(prefix);
    let items = rows.map((row) => ({ id: row.key.slice(prefix.length), value: recordOf(row.value) }));
    if (q.where) items = items.filter((item) => matchesWhere(item.value, q.where));
    items.sort((left, right) => {
      for (const rule of order) {
        const a = left.value && typeof left.value === 'object' ? sortValue(left.value[rule.field]) : null;
        const b = right.value && typeof right.value === 'object' ? sortValue(right.value[rule.field]) : null;
        const diff = compareValues(a, b);
        if (diff !== 0) return diff * rule.dir;
      }
      return compareValues(left.id, right.id);
    });
    if (q.cursor) {
      const at = decodeCursor(q.cursor);
      if (at && Array.isArray(at.v)) {
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
    }
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    let next = null;
    if (hasMore && page.length > 0) {
      const tail = page[page.length - 1];
      next = encodeCursor(order.map((rule) => (tail.value && typeof tail.value === 'object' ? sortValue(tail.value[rule.field]) : null)), tail.id);
    }
    return {
      items: page.map((item) => (item.value && typeof item.value === 'object' && !Array.isArray(item.value) ? Object.assign({ id: item.id }, item.value) : item.value)),
      next,
    };
  }
}

__SQL_STORE__
__STORE_SELECT__

// ---------- entity store ----------

// A body never names a provider; it names an entity. The adapter owns the key
// layout, the unique index and the ordering, so the same body runs on kv or sql.
class ArcodError extends Error {
  constructor(name) {
    super(name);
    this.name = name;
    this.error = name;
  }
}

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
  return 'unique:' + entity + ':' + field + ':' + String(value);
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

function encodeCursor(values, id) {
  return Buffer.from(JSON.stringify({ v: values, id })).toString('base64url');
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

function matchesWhere(value, where) {
  for (const field of Object.keys(where || {})) {
    const cond = where[field];
    const actual = value && typeof value === 'object' ? value[field] : null;
    if (scalarOf(cond)) {
      if (actual != cond) return false;
      continue;
    }
    for (const op of Object.keys(cond)) {
      const expected = cond[op];
      if (op === 'eq' && actual != expected) return false;
      if (op === 'ne' && actual == expected) return false;
      if (op === 'in' && !(Array.isArray(expected) && expected.some((item) => item == actual))) return false;
      if (op === 'contains' && !String(actual == null ? '' : actual).includes(String(expected))) return false;
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
  if (!meta) throw new ArcodError('Internal');
  return meta;
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

function sendError(res, name) {
  const info = ERRORS[name] || { status: 500, message: 'internal error' };
  send(res, info.status, JSON.stringify({ error: name, message: info.message }));
}

function matchRoute(method, pathname) {
  const actual = pathname.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const expected = route.path.split('/').filter(Boolean);
    if (expected.length !== actual.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].startsWith(':')) {
        params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
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
    if (url.pathname === '/healthz') {
      try {
        await store.ping();
        send(res, 200, JSON.stringify({ status: 'ok', service: CONFIG.service, kv: 'up' }));
        finish('/healthz', '', 200, start, req);
      } catch {
        send(res, 503, JSON.stringify({ status: 'degraded', kv: 'down' }));
        finish('/healthz', '', 503, start, req);
      }
      return;
    }

    if (url.pathname === '/metrics') {
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
    console.error('request failed:', err && err.message ? err.message : err);
    send(res, 500, JSON.stringify({ error: 'Internal', message: 'internal error' }));
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

// The model names a capability; the generated adapter is whatever the
// environment can provision. kv gets a Redis client, sql a MySQL client.
function serviceTemplate(svc: ServiceNode): string {
  if (storageKind(svc) === 'sql') {
    return streamSource(dropRedis(SERVICE_TEMPLATE), svc)
      .replace('__SQL_STORE__', () => SQL_STORE_SOURCE)
      .replace('__STORE_SELECT__', () => [
        "const store = process.env.SQL_DRIVER === 'memory'",
        '  ? new MemoryStore()',
        "  : new SqlStore(process.env.DATABASE_URL || 'mysql://arcod:arcod@mysql:3306/arcod');",
      ].join('\n'));
  }
  return streamSource(SERVICE_TEMPLATE, svc)
    .replace('__SQL_STORE__', () => '')
    .replace('__STORE_SELECT__', () => [
      "const store = process.env.KV_DRIVER === 'memory'",
      '  ? new MemoryStore()',
      "  : new RedisStore(process.env.KV_HOST || 'kv', Number(process.env.KV_PORT || 6379));",
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

function cryptoImportFor(svc: ServiceNode, withBodies: boolean): string {
  const names = ['randomUUID'];
  if (withBodies && isGuarded(svc)) names.push('randomBytes', 'scryptSync', 'timingSafeEqual');
  if (storageKind(svc) === 'sql') names.push('constants', 'createHash', 'createPublicKey', 'publicEncrypt');
  if (hasStream(svc)) names.push('createHash');
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
      return { method: parts[0], path: parts[1], op: op.name };
    });

  const errors: Record<string, { status: number; message: string }> = {};
  for (const op of svc.contract) {
    for (const clause of op.clauses) {
      if (clause.kind !== 'errors') continue;
      for (const name of clause.names) errors[name] = errorInfo(name);
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
  const template = withHandlers(serviceTemplate(svc), reference, svc, options.impl, externals)
    .replace(CRYPTO_IMPORT, () => cryptoImportFor(svc, reference || Boolean(options.impl)))
    .replace('__QUEUE_SOURCE__\n', () => queueSourceFor(svc, options.impl) + (outboxActive(svc) && options.impl ? OUTBOX_SOURCE + '\n' : ''))
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

  const stores = storageKind(svc) === 'sql' ? sqlEntityStores(mod, svc) : entityStores(mod, svc);

  return header + template
    .replace('__CONFIG__', () => JSON.stringify(config, null, 2))
    .replace('__STORES__', () => JSON.stringify(stores, null, 2))
    .replace('__MIGRATIONS__', () => JSON.stringify(migrationPlan(mod, svc).migrations))
    .replace('__ROUTES__', () => JSON.stringify(routes, null, 2))
    .replace('__ERRORS__', () => JSON.stringify(errors, null, 2))
    .replace('__ATOMIC__', () => String(atomicRead))
    .replace('__STREAM_WIRE__', hasStream(svc)
      ? "server.on('upgrade', (req, socket, head) => wsUpgrade(req, socket, head));"
      : '');
}

function withHandlers(template: string, reference: boolean, svc: ServiceNode, impl?: Record<string, string>, externals: ServiceNode[] = []): string {
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
    const handlers = implHandlers(svc, impl, hashing, externals);
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
function sqlEntityIoLines(): string[] {
  return [
    '    async fetch(entity, id) {',
    '      metricCapability("store.fetch");',
    '      const meta = requestEntity(entity);',
    '      return await store.entityFetch(meta.table, meta.columns, id);',
    '    },',
    '    async insert(entity, record) {',
    '      metricCapability("store.insert");',
    '      const meta = requestEntity(entity);',
    '      const value = Object.assign({}, record || {});',
    "      if (value.id == null || value.id === '') throw new ArcodError('Invalid');",
    '      await store.entityInsert(meta.table, meta.columns, value);',
    '      return value;',
    '    },',
    '    async update(entity, id, patch) {',
    '      metricCapability("store.update");',
    '      const meta = requestEntity(entity);',
    '      return await store.entityUpdate(meta.table, meta.columns, id, patch);',
    '    },',
    '    async remove(entity, id) {',
    '      metricCapability("store.remove");',
    '      const meta = requestEntity(entity);',
    '      await store.entityRemove(meta.table, meta.columns, id);',
    '      return true;',
    '    },',
    '    async find(entity, query) {',
    '      metricCapability("store.find");',
    '      const meta = requestEntity(entity);',
    '      return await store.entityFind(meta.table, meta.columns, query);',
    '    },',
  ];
}

function implHandlers(svc: ServiceNode, impl: Record<string, string>, guarded: boolean, externals: ServiceNode[] = []): string {
  const bodies = svc.contract.filter((op) => impl[op.name]);
  const ops = bodies.filter((op) => op.kind === 'op');
  const names = bodies.map((op) => op.name);
  const parts: string[] = [];

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
    '    async fetch(entity, id) {',
    '      metricCapability("store.fetch");',
    '      const meta = requestEntity(entity);',
    "      const raw = await store.get(meta.prefix + String(id));",
    '      return raw == null ? null : recordOf(raw);',
    '    },',
    '    async insert(entity, record) {',
    '      metricCapability("store.insert");',
    '      const meta = requestEntity(entity);',
    '      const value = Object.assign({}, record || {});',
    "      if (value.id == null || value.id === '') throw new ArcodError('Invalid');",
    "      const key = meta.prefix + String(value.id);",
    "      if (await store.exists(key)) throw new ArcodError('Conflict');",
    '      const claimed = [];',
    '      for (const field of meta.unique) {',
    '        const fieldValue = value[field];',
    '        if (fieldValue == null) continue;',
    '        const claim = uniqueKey(entity, field, fieldValue);',
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
    '      const key = meta.prefix + String(id);',
    '      const raw = await store.get(key);',
    "      if (raw == null) throw new ArcodError('NotFound');",
    '      const current = recordOf(raw);',
    '      const base = current && typeof current === "object" ? current : {};',
    '      const value = Object.assign({}, base, patch || {});',
    '      if (value.id == null) value.id = id;',
    '      const claimed = [];',
    '      const released = [];',
    '      for (const field of meta.unique) {',
    '        const before = base[field];',
    '        const after = value[field];',
    '        if (String(before) === String(after)) continue;',
    '        if (after != null) {',
    '          const claim = uniqueKey(entity, field, after);',
    '          if (!(await store.claim(claim))) {',
    '            for (const item of claimed) await store.del(item);',
    "            throw new ArcodError('Conflict');",
    '          }',
    '          claimed.push(claim);',
    '        }',
    '        if (before != null) released.push(uniqueKey(entity, field, before));',
    '      }',
    '      await store.set(key, JSON.stringify({ b: value, h: null }), CONFIG.ttlMs);',
    '      for (const item of released) await store.del(item);',
    '      return value;',
    '    },',
    '    async remove(entity, id) {',
    '      metricCapability("store.remove");',
    '      const meta = requestEntity(entity);',
    '      const key = meta.prefix + String(id);',
    '      const raw = await store.get(key);',
    '      if (raw == null) return false;',
    '      const current = recordOf(raw);',
    '      await store.del(key);',
    '      for (const field of meta.unique) {',
    '        const fieldValue = current && current[field];',
    '        if (fieldValue != null) await store.del(uniqueKey(entity, field, fieldValue));',
    '      }',
    '      return true;',
    '    },',
    '    async find(entity, query) {',
    '      metricCapability("store.find");',
    '      const meta = requestEntity(entity);',
    '      const q = query || {};',
    '      const requested = Number(q.limit);',
    '      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;',
    '      const order = parseOrder(q.order);',
    '      const rows = await store.scan(meta.prefix);',
    '      let items = rows.map((row) => ({ id: row.key.slice(meta.prefix.length), value: recordOf(row.value) }));',
    '      if (q.where) items = items.filter((item) => matchesWhere(item.value, q.where));',
    '      items.sort((left, right) => {',
    '        for (const rule of order) {',
    '          const a = left.value && typeof left.value === "object" ? sortValue(left.value[rule.field]) : null;',
    '          const b = right.value && typeof right.value === "object" ? sortValue(right.value[rule.field]) : null;',
    '          const diff = compareValues(a, b);',
    '          if (diff !== 0) return diff * rule.dir;',
    '        }',
    '        return compareValues(left.id, right.id);',
    '      });',
    '      if (q.cursor) {',
    '        const at = decodeCursor(q.cursor);',
    '        if (at && Array.isArray(at.v)) {',
    '          const after = (item) => {',
    '            for (let index = 0; index < order.length; index++) {',
    '              const rule = order[index];',
    '              const value = item.value && typeof item.value === "object" ? sortValue(item.value[rule.field]) : null;',
    '              const diff = compareValues(value, at.v[index]);',
    '              if (diff !== 0) return diff * rule.dir;',
    '            }',
    '            return compareValues(item.id, at.id);',
    '          };',
    '          items = items.filter((item) => after(item) > 0);',
    '        }',
    '      }',
    '      const page = items.slice(0, limit);',
    '      const tail = page[page.length - 1];',
    '      const next = items.length > limit && tail',
    '        ? encodeCursor(order.map((rule) => (tail.value && typeof tail.value === "object" ? sortValue(tail.value[rule.field]) : null)), tail.id)',
    '        : null;',
    '      return {',
    '        items: page.map((item) => (item.value && typeof item.value === "object" && !Array.isArray(item.value) ? Object.assign({ id: item.id }, item.value) : item.value)),',
    '        next,',
    '      };',
    '    },',
  );

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
    '    if (error && error.error) return sendError(res, String(error.error));',
    '    console.error(error);',
    "    return sendError(res, 'Internal');",
    '  }',
    '  if (out && out.error) return sendError(res, out.error);',
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
    const status = method === 'GET' ? 200 : 201;
    parts.push(
      'async function handle' + cap + '(req, res, params) {',
      "  return callImpl(req, res, params, impl" + cap + ', [' + names.map((name) => "'" + name + "'").join(', ') + '], ' + status + ", '" + op.name + "');",
      '}',
      '',
    );
  }

  parts.push('const HANDLERS = {');
  for (const op of ops) {
    parts.push('  ' + op.name + ': handle' + op.name.charAt(0).toUpperCase() + op.name.slice(1) + ',');
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
    if (route.path.includes(':' + key)) {
      path = path.split(':' + key).join(encodeURIComponent(String(values[key])));
    } else if (route.method === 'GET' || route.method === 'DELETE') {
      query.append(key, String(values[key]));
    } else {
      body[key] = values[key];
    }
  }
  const url = base + path + (query.toString() ? '?' + query.toString() : '');
  const init = { method: route.method, headers: { 'content-type': 'application/json' } };
  const ctx = requestCtx.getStore();
  if (ctx && ctx.id) init.headers['x-request-id'] = ctx.id;
  if (CONFIG.timeoutMs) init.signal = AbortSignal.timeout(CONFIG.timeoutMs);
  if (route.method !== 'GET' && route.method !== 'DELETE') init.body = JSON.stringify(body);

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

function entityStores(mod: ModuleNode, svc: ServiceNode): Record<string, { prefix: string; unique: string[] }> {
  const table: Record<string, { prefix: string; unique: string[] }> = {};
  const uniques: Array<[string, string]> = [];
  for (const rule of svc.rules) {
    if (rule.kind !== 'unique') continue;
    const parts = rule.path.split('.');
    if (parts.length === 2) uniques.push([parts[0], parts[1]]);
  }
  for (const decl of mod.types) {
    // Only record shapes are storable; aliases point at one.
    if (decl.type.kind !== 'record') continue;
    table[decl.name] = {
      prefix: decl.name.toLowerCase() + ':',
      unique: uniques.filter(([entity]) => entity === decl.name).map(([, field]) => field),
    };
  }
  return table;
}

function sqlEntityStores(mod: ModuleNode, svc: ServiceNode): Record<string, { table: string; columns: unknown[]; unique: string[] }> {
  const table: Record<string, { table: string; columns: unknown[]; unique: string[] }> = {};
  const uniquesByEntity: Record<string, string[]> = {};
  for (const rule of svc.rules) {
    if (rule.kind !== 'unique') continue;
    const parts = rule.path.split('.');
    if (parts.length === 2) (uniquesByEntity[parts[0]] ??= []).push(parts[1]);
  }
  for (const decl of mod.types) {
    if (decl.type.kind !== 'record') continue;
    const unique = uniquesByEntity[decl.name] ?? [];
    table[decl.name] = {
      table: decl.name.toLowerCase(),
      columns: recordColumns(mod, decl, unique),
      unique,
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

// Bounds of a single parameter, used by the generated UI. Text types default
// to a 64 KB ceiling; refinements (min/max, 64kb) win.
export function paramLimits(mod: ModuleNode, type: TypeExpr): { min: number; max: number; multiline: boolean } {
  const resolved = resolveType(mod, type);
  if (resolved.kind !== 'named') return { min: 1, max: 4096, multiline: true };
  const text = resolved.name === 'string' || resolved.name === 'bytes';
  let min = text ? 1 : 0;
  let max = text ? 64 * 1024 : 1024;
  for (const arg of resolved.args) {
    if (arg.value.kind === 'literal' && typeof arg.value.value === 'number') {
      if (arg.name === 'min') min = arg.value.value;
      if (arg.name === 'max') max = arg.value.value;
    } else if (arg.name === 'max' && arg.value.kind === 'duration') {
      max = sizeBytes(arg.value.value, arg.value.unit);
    }
  }
  return { min, max, multiline: text && max > 512 };
}

export function statusForError(name: string): number {
  return errorInfo(name).status;
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
