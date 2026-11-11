import type { ModuleNode, OpNode, ServiceNode, TypeExpr } from './ast.ts';
import { asOnce } from '../check.ts';
import { HANDLER_TEMPLATES, templateFor } from '../templates.ts';
import { SQL_STORE_SOURCE } from './sql-store.ts';
import { IDENTITY_SOURCE } from './identity.ts';
import { BLOB_SOURCE } from './blob.ts';
import { LLM_SOURCE } from './llm.ts';
import { storageKind, storageUse } from '../capabilities.ts';

export interface EmitOptions {
  port?: number;
  reference?: boolean;
  impl?: Record<string, string>;
}

const SERVICE_TEMPLATE = `import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const CONFIG = __CONFIG__;
const ROUTES = __ROUTES__;
const ERRORS = __ERRORS__;

let inFlight = 0;

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
}

__SQL_STORE__
__STORE_SELECT__

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
    const handler = HANDLERS[route.op];
    if (!handler) return send(res, 501, JSON.stringify({ error: 'NotImplemented', op: route.op }));

    return await handler(req, res, route.params);
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

const CRYPTO_IMPORT = "import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';";

// The model names a capability; the generated adapter is whatever the
// environment can provision. kv gets a Redis client, sql a MySQL client.
function serviceTemplate(svc: ServiceNode): string {
  if (storageKind(svc) === 'sql') {
    return dropRedis(SERVICE_TEMPLATE)
      .replace('__SQL_STORE__', SQL_STORE_SOURCE)
      .replace('__STORE_SELECT__', [
        "const store = process.env.SQL_DRIVER === 'memory'",
        '  ? new MemoryStore()',
        "  : new SqlStore(process.env.DATABASE_URL || 'mysql://arcod:arcod@mysql:3306/arcod');",
      ].join('\n'));
  }
  return SERVICE_TEMPLATE
    .replace('__SQL_STORE__', '')
    .replace('__STORE_SELECT__', [
      "const store = process.env.KV_DRIVER === 'memory'",
      '  ? new MemoryStore()',
      "  : new RedisStore(process.env.KV_HOST || 'kv', Number(process.env.KV_PORT || 6379));",
    ].join('\n'));
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
  const missing = opNames.filter((name) => !templateFor(name, isGuarded(svc)));
  // Bodies supplied by the caller do not need a built-in template.
  if (!options.impl && (!opNames.includes('create') || !opNames.includes('read') || missing.length > 0)) {
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
    consumedError: consumedErrorName(svc) ?? (errors.Gone ? 'Gone' : 'NotFound'),
  };

  const readOp = svc.contract.find((op) => op.name === 'read');
  const atomicRead = Boolean(readOp && svc.rules.some((rule) => rule.kind === 'atomic' && rule.name === readOp.name));

  const reference = options.reference === true && !options.impl;
  const template = withHandlers(serviceTemplate(svc), reference, svc, options.impl)
    .replace(CRYPTO_IMPORT, cryptoImportFor(svc, reference || Boolean(options.impl)));
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

  return header + template
    .replace('__CONFIG__', JSON.stringify(config, null, 2))
    .replace('__ROUTES__', JSON.stringify(routes, null, 2))
    .replace('__ERRORS__', JSON.stringify(errors, null, 2))
    .replace('__ATOMIC__', String(atomicRead));
}

function withHandlers(template: string, reference: boolean, svc: ServiceNode, impl?: Record<string, string>): string {
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
    const handlers = implHandlers(svc, impl, hashing);
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

function implHandlers(svc: ServiceNode, impl: Record<string, string>, guarded: boolean): string {
  const ops = svc.contract.filter((op) => op.kind === 'op' && impl[op.name]);
  const names = ops.map((op) => op.name);
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

  if (hasIdentity) parts.push(IDENTITY_SOURCE);
  if (hasBlob) parts.push(BLOB_SOURCE);
  if (hasLlm) parts.push(LLM_SOURCE);

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

  if (hasIdentity) {
    parts.push(
      '    async actor() {',
      '      if (!actorPromise) actorPromise = actorFrom(req);',
      '      return actorPromise;',
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
    'async function callImpl(req, res, params, implFn, names, status) {',
    '  const input = await readInput(req, params, names);',
    '  if (input && input.error) return sendError(res, input.error);',
    '  const out = await implFn(input, makeIo(req));',
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
      '  return callImpl(req, res, params, impl' + cap + ', [' + names.map((name) => "'" + name + "'").join(', ') + '], ' + status + ');',
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
    const decl = mod.types.find((item) => item.name === current.name);
    if (!decl) return current;
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
