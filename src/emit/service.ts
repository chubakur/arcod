import type { ModuleNode, OpNode, ServiceNode, TypeExpr } from './ast.ts';
import { asOnce } from '../check.ts';

export interface EmitOptions {
  port?: number;
}

const SERVICE_TEMPLATE = `import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const CONFIG = __CONFIG__;
const ROUTES = __ROUTES__;
const ERRORS = __ERRORS__;

let inFlight = 0;

const ATOMIC_READ = __ATOMIC__;

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

class MemoryStore {
  constructor() {
    this.map = new Map();
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
}

const store = process.env.KV_DRIVER === 'memory'
  ? new MemoryStore()
  : new RedisStore(process.env.KV_HOST || 'kv', Number(process.env.KV_PORT || 6379));

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
    if (ok) return { op: route.op, params };
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

async function handleRead(res, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return sendError(res, 'NotFound');
  }
  const result = await store.take('msg:' + id, 'gone:' + id, CONFIG.goneTtlMs, ATOMIC_READ);
  if (result.state === 'ok') return send(res, 200, result.value, 'text/plain; charset=utf-8');
  if (result.state === 'gone') return sendError(res, CONFIG.consumedError);
  return sendError(res, 'NotFound');
}

const server = http.createServer(async (req, res) => {
  if (CONFIG.concurrency) {
    if (inFlight >= CONFIG.concurrency) {
      return send(res, 503, JSON.stringify({ error: 'Unavailable', message: 'too many concurrent requests' }));
    }
    inFlight++;
    res.on('close', () => { inFlight--; });
  }

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      try {
        await store.ping();
        return send(res, 200, JSON.stringify({ status: 'ok', service: CONFIG.service, kv: 'up' }));
      } catch {
        return send(res, 503, JSON.stringify({ status: 'degraded', kv: 'down' }));
      }
    }

    const route = matchRoute(req.method || 'GET', url.pathname);
    if (!route) return sendError(res, 'NotFound');
    if (route.op === 'create') return await handleCreate(req, res);
    if (route.op === 'read') return await handleRead(res, route.params.id);

    send(res, 501, JSON.stringify({ error: 'NotImplemented', op: route.op }));
  } catch (err) {
    console.error('request failed:', err && err.message ? err.message : err);
    send(res, 500, JSON.stringify({ error: 'Internal', message: 'internal error' }));
  }
});

const PORT = Number(process.env.PORT || CONFIG.port);

server.listen(PORT, '0.0.0.0', () => {
  console.log('arcod service ' + CONFIG.service + ' listening on :' + PORT);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
`;

export function emitService(mod: ModuleNode, options: EmitOptions = {}): string {
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to emit');
  const opNames = svc.contract.filter((op) => op.kind === 'op').map((op) => op.name);
  if (!opNames.includes('create') || !opNames.includes('read')) {
    throw new Error('emitter v0 supports create + read over kv, got: ' + opNames.join(', '));
  }

  const ttlMs = kvTtlMs(svc);
  const createOp = svc.contract.find((op) => op.name === 'create')!;
  const limits = bodyLimits(mod, createOp);
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
    consumedError: consumedErrorName(svc) ?? (errors.Gone ? 'Gone' : 'NotFound'),
  };

  const readOp = svc.contract.find((op) => op.name === 'read');
  const atomicRead = Boolean(readOp && svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === readOp.name));

  return (
    '// Generated by arcod from ' + mod.name + '@' + mod.version + ' (' + svc.name + '). Do not edit.\n' +
    '// Source of truth: the .arc specification.\n' +
    SERVICE_TEMPLATE
      .replace('__CONFIG__', JSON.stringify(config, null, 2))
      .replace('__ROUTES__', JSON.stringify(routes, null, 2))
      .replace('__ERRORS__', JSON.stringify(errors, null, 2))
      .replace('__ATOMIC__', String(atomicRead))
  );
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

export function pickService(mod: ModuleNode): ServiceNode | null {
  return mod.services.find((svc) => !svc.external) ?? null;
}

export function routeOf(op: OpNode): string | null {
  const clause = op.clauses.find((c) => c.kind === 'route');
  return clause && clause.kind === 'route' ? clause.value : null;
}

function kvTtlMs(svc: ServiceNode): number {
  const kv = svc.uses.find((use) => use.capability === 'kv' || use.capability.endsWith('.kv'));
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
      if (arg.value.kind === 'duration') max = durationMs(arg.value.value, arg.value.unit) / 1000;
    }
  }
  return { min, max };
}

function resolveType(mod: ModuleNode, type: TypeExpr): TypeExpr {
  let current = type;
  for (let depth = 0; depth < 8; depth++) {
    if (current.kind !== 'named') return current;
    const decl = mod.types.find((item) => item.name === current.name);
    if (!decl) return current;
    current = decl.type;
  }
  return current;
}

export function statusForError(name: string): number {
  return errorInfo(name).status;
}

function errorInfo(name: string): { status: number; message: string } {
  const table: Record<string, { status: number; message: string }> = {
    Invalid: { status: 400, message: 'invalid request' },
    Unauthorized: { status: 401, message: 'unauthorized' },
    Forbidden: { status: 403, message: 'forbidden' },
    NotFound: { status: 404, message: 'not found' },
    Gone: { status: 410, message: 'already consumed' },
    Conflict: { status: 409, message: 'conflict' },
    RateLimited: { status: 429, message: 'too many requests' },
    Unavailable: { status: 503, message: 'temporarily unavailable' },
  };
  return table[name] ?? { status: 500, message: name };
}
