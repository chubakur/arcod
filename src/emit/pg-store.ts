// Postgres wire client for the generated service (B5.2).
//
// The service has no dependencies: like the MySQL client in sql-store.ts this
// speaks the frontend/backend text protocol over node:net. It is a separate
// source so build can embed it next to (or instead of) the MySQL client and
// pick by the DATABASE_URL scheme.
//
// Supported: startup, trust/cleartext/MD5/SCRAM-SHA-256 auth, simple query,
// RowDescription/DataRow, SQLSTATE errors. Values are rendered as typed
// literals, never concatenated from request text.
export const PG_STORE_SOURCE = `// ---------- postgres ----------

import { connect as pgConnect } from 'node:net';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const PG_PROTOCOL = 196608;

export class PgError extends Error {
  constructor(code, message, severity) {
    super('postgres ' + code + ': ' + message);
    this.code = code;
    this.severity = severity || 'ERROR';
  }
}

// A unique violation is the same failure on both dialects: 23505 on Postgres,
// ER_DUP_ENTRY (1062) on MySQL. The store maps it to Conflict.
export function pgIsUnique(error) {
  return Boolean(error && (error.code === '23505' || String(error.message || '').includes('postgres 23505')));
}

export function pgParseUrl(url) {
  const text = String(url || '');
  let parsed;
  try { parsed = new URL(String(url || "")); }
  catch { throw new Error("postgres: cannot parse DATABASE_URL"); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("postgres: cannot parse DATABASE_URL");
  }
  return {
    user: decodeURIComponent(parsed.username || "arcod"),
    password: decodeURIComponent(parsed.password || ""),
    host: parsed.hostname || "localhost",
    port: Number(parsed.port || 5432),
    database: decodeURIComponent((parsed.pathname || "/arcod").slice(1) || "arcod"),
  };
}

function pgCString(value) {
  return Buffer.concat([Buffer.from(String(value), 'utf8'), Buffer.from([0])]);
}

function pgAttr(list) {
  const out = {};
  for (const part of String(list).split(',')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

// RFC 5802/7677 client-final for SCRAM-SHA-256. Exported so the test can check
// the published RFC 7677 vector without a server.
export function pgScramFinal(password, serverFirst, clientFirstBare) {
  const attrs = pgAttr(serverFirst);
  if (!attrs.r || !attrs.s || !attrs.i) throw new Error('postgres: malformed SCRAM server-first message');
  const salt = Buffer.from(attrs.s, 'base64');
  const salted = pbkdf2Sync(String(password), salt, Number(attrs.i), 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = 'c=biws,r=' + attrs.r;
  const authMessage = clientFirstBare + ',' + serverFirst + ',' + withoutProof;
  const signature = createHmac('sha256', storedKey).update(authMessage).digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ signature[i];
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
  return { clientFinal: withoutProof + ',p=' + proof.toString('base64'), serverSignature };
}

// Typed cell codec: a column base type decides how a text cell becomes a value.
export function readPgCell(base, value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (base === 'int' || base === 'float' || base === 'number' || base === 'decimal') {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (base === 'bool' || base === 'boolean') return text === 't' || text === 'true' || text === '1';
  if (base === 'datetime') {
    const iso = text.replace(' ', 'T');
    if (iso.endsWith('+00')) return iso.slice(0, -3) + 'Z';
    if (iso.endsWith('+00:00')) return iso.slice(0, -6) + 'Z';
    return iso;
  }
  if (base === 'bytes') {
    if (text.slice(0, 2) === String.fromCharCode(92) + 'x') return Buffer.from(text.slice(2), 'hex');
    return Buffer.from(text, 'utf8');
  }
  if (base === 'json' || base === 'list' || base === 'map') {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

export function pgLiteral(base, value) {
  if (value === null || value === undefined) return 'NULL';
  if (base === 'bool' || base === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (base === 'int' || base === 'float' || base === 'number' || base === 'decimal') {
    const n = Number(value);
    if (Number.isFinite(n)) return String(n);
    return pgQuote(String(value));
  }
  if (base === 'datetime') return pgQuote(String(value).replace('T', ' ').replace(/Z$/, '')) + '::timestamptz';
  if (base === 'bytes') return "decode('" + Buffer.from(String(value), 'utf8').toString('hex') + "', 'hex')";
  if (base === 'json' || base === 'list' || base === 'map') return pgQuote(JSON.stringify(value)) + '::jsonb';
  return pgQuote(String(value));
}

function pgQuote(text) {
  return "'" + String(text).split("'").join("''") + "'";
}

export class PgConnection {
  constructor(url) {
    this.options = pgParseUrl(url);
    this.socket = null;
    this.dead = false;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.ready = null;
    this.failed = null;
    this.queue = [];
    this.startupParams = null;
    this.clientNonce = null;
    this.clientFirstBare = null;
    this.serverSignature = null;
    this.fields = [];
  }

  async connect(timeoutMs) {
    const options = this.options;
    return await new Promise((resolve, reject) => {
      const socket = pgConnect({ host: options.host, port: options.port });
      this.socket = socket;
      this.dead = false;
      this.buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (this.socket === socket) { this.socket = null; this.dead = true; }
        socket.destroy();
        reject(new Error('postgres: connect timeout'));
      }, timeoutMs || 5000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      this.ready = { resolve, reject: fail, timer };
      // A dropped socket fails everything in flight and every queued
      // statement; PgStore reconnects before the next query. The handlers
      // ignore a socket that has already been replaced by a newer one.
      socket.on('error', (error) => {
        if (this.socket !== socket) return;
        clearTimeout(timer);
        this.failConnection(error);
        socket.destroy();
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        clearTimeout(timer);
        this.failConnection(new Error('postgres connection closed'));
      });
      socket.on('connect', () => {
        this.clientNonce = randomBytes(18).toString('base64');
        this.clientFirstBare = 'n=,r=' + this.clientNonce;
        const params = Buffer.concat([
          pgCString('user'), pgCString(options.user),
          pgCString('database'), pgCString(options.database),
          pgCString('client_encoding'), pgCString('UTF8'),
          Buffer.from([0]),
        ]);
        const payload = Buffer.alloc(4 + params.length);
        payload.writeInt32BE(PG_PROTOCOL, 0);
        params.copy(payload, 4);
        const head = Buffer.alloc(4);
        head.writeInt32BE(payload.length + 4, 0);
        socket.write(Buffer.concat([head, payload]));
      });
      socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      if (length < 4) { this.failAll(new Error('postgres: bad message length')); return; }
      if (this.buffer.length < 1 + length) return;
      const payload = this.buffer.subarray(5, 1 + length);
      this.buffer = this.buffer.subarray(1 + length);
      this.onMessage(type, payload);
    }
  }

  alive() {
    return Boolean(this.socket && !this.dead);
  }

  failConnection(error) {
    this.dead = true;
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    if (this.pending) { const pending = this.pending; this.pending = null; pending.reject(error); }
    if (this.ready) {
      const ready = this.ready;
      this.ready = null;
      clearTimeout(ready.timer);
      ready.reject(error);
    }
    const queued = this.queue.splice(0, this.queue.length);
    for (const item of queued) item.reject(error);
  }

  // Transport or startup failures end the connection; a statement error does
  // not (see onMessage).
  failAll(error) {
    this.failConnection(error);
  }

  send(type, payload) {
    const head = Buffer.alloc(5);
    head.write(type, 0);
    head.writeInt32BE(payload.length + 4, 1);
    this.socket.write(Buffer.concat([head, payload]));
  }

  onMessage(type, payload) {
    if (type === 'R') { this.onAuth(payload); return; }
    if (type === 'E') {
      const error = pgError(payload);
      // A statement error is a normal answer: postgres still finishes the
      // message stream with ReadyForQuery and the socket stays usable. The
      // error is held for the statement in flight and rejected on 'Z'.
      // Startup errors (no statement in flight) stay fatal.
      if (!this.pending) { this.failAll(error); return; }
      if (!this.pending.error) this.pending.error = error;
      return;
    }
    if (type === 'Z') {
      if (this.ready) {
        const ready = this.ready;
        this.ready = null;
        clearTimeout(ready.timer);
        ready.resolve(true);
      }
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        if (pending.error) pending.reject(pending.error);
        else pending.resolve({ fields: pending.fields, rows: pending.rows, affected: pending.affected || 0 });
        this.flushQueue();
      }
      return;
    }
    if (type === 'T') { if (this.pending) this.pending.fields = pgFields(payload); return; }
    if (type === 'D') { if (this.pending) this.pending.rows.push(pgRow(payload)); return; }
    // The command tag carries the row count: INSERT 0 3, UPDATE 2, DELETE 1.
    if (type === 'C') { if (this.pending) this.pending.affected = pgTagCount(payload); return; }
    // S/K/N/1/2/3/A: status, notices and parameter status need no handling here.
  }

  onAuth(payload) {
    const code = payload.readInt32BE(0);
    if (code === 0) return;
    const password = this.options.password;
    if (code === 3) { this.send('p', pgCString(password)); return; }
    if (code === 5) {
      const salt = payload.subarray(4, 8);
      const inner = createHash('md5').update(String(password) + this.options.user).digest('hex');
      const outer = createHash('md5').update(inner).update(salt).digest('hex');
      this.send('p', pgCString('md5' + outer));
      return;
    }
    if (code === 10) {
      const mechanisms = payload.subarray(4).toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
      if (!mechanisms.includes('SCRAM-SHA-256')) {
        this.failAll(new Error('postgres: server offers no SCRAM-SHA-256 (' + mechanisms.join(', ') + ')'));
        return;
      }
      // SASLInitialResponse carries the gs2 header before the bare message:
      // postgres reads the first character as channel-binding flag ('n'), then
      // expects a comma. The bare string (auth message) stays untouched.
      const first = Buffer.from('n,,' + this.clientFirstBare, 'utf8');
      const head = Buffer.alloc(4);
      head.writeInt32BE(first.length, 0);
      this.send('p', Buffer.concat([pgCString('SCRAM-SHA-256'), head, first]));
      return;
    }
    if (code === 11) {
      const serverFirst = payload.subarray(4).toString('utf8');
      const attrs = pgAttr(serverFirst);
      if (!attrs.r || !attrs.r.startsWith(this.clientNonce)) {
        this.failAll(new Error('postgres: SCRAM nonce mismatch'));
        return;
      }
      const final = pgScramFinal(password, serverFirst, this.clientFirstBare);
      this.serverSignature = final.serverSignature;
      this.send('p', Buffer.from(final.clientFinal, 'utf8'));
      return;
    }
    if (code === 12) {
      const attrs = pgAttr(payload.subarray(4).toString('utf8'));
      const expected = Buffer.from(this.serverSignature || '', 'utf8');
      const actual = Buffer.from(attrs.v || '', 'utf8');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        this.failAll(new Error('postgres: SCRAM server signature mismatch'));
      }
      return;
    }
    this.failAll(new Error('postgres: unsupported auth method ' + code));
  }

  async query(sql) {
    if (!this.socket) throw new Error('postgres: not connected');
    // One socket serves the whole service: requests queue in arrival order and
    // the next one is written when the current ReadyForQuery arrives. The
    // store calls query() from many request contexts at once.
    return await new Promise((resolve, reject) => {
      this.queue.push({ sql, resolve, reject });
      this.flushQueue();
    });
  }

  flushQueue() {
    if (this.pending || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.pending = { resolve: next.resolve, reject: next.reject, fields: [], rows: [], affected: 0 };
    this.send('Q', pgCString(next.sql));
  }

  async run(sql) {
    return await this.query(sql);
  }

  async end() {
    if (!this.socket) { this.dead = true; return; }
    this.send('X', Buffer.alloc(0));
    this.socket.end();
    this.socket = null;
    this.dead = true;
  }
}

function pgError(payload) {
  const fields = {};
  let at = 0;
  while (at < payload.length && payload[at] !== 0) {
    const key = String.fromCharCode(payload[at]);
    at += 1;
    const end = payload.indexOf(0, at);
    const stop = end < 0 ? payload.length : end;
    fields[key] = payload.toString('utf8', at, stop);
    at = stop + 1;
  }
  return new PgError(fields.C || 'XX000', fields.M || 'server error', fields.S);
}

function pgFields(payload) {
  const count = payload.readInt16BE(0);
  const fields = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    const end = payload.indexOf(0, at);
    fields.push(payload.toString('utf8', at, end));
    at = end + 1 + 4 + 2 + 4 + 2 + 4 + 2;
  }
  return fields;
}

function pgTagCount(payload) {
  const parts = payload.toString('utf8').split(String.fromCharCode(0)).join('').trim().split(' ');
  const count = Number(parts[parts.length - 1]);
  return Number.isFinite(count) ? count : 0;
}

function pgRow(payload) {
  const count = payload.readInt16BE(0);
  const row = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    const length = payload.readInt32BE(at);
    at += 4;
    if (length < 0) { row.push(null); continue; }
    row.push(payload.toString('utf8', at, at + length));
    at += length;
  }
  return row;
}
`;

export const PG_SQL_STORE_SOURCE = `// ---------- postgres store ----------
//
// The store contract SqlStore implements, on the wire client above: same
// operations, double-quoted identifiers, pgLiteral values and this dialect's
// migration changelog.

const MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL)';

async function applyMigrations(connection) {
  await connection.run(MIGRATIONS_TABLE);
  for (const migration of MIGRATIONS) {
    const found = await connection.run(
      'SELECT checksum FROM arcod_migrations WHERE version = ' + pgLiteral('string', migration.version) + ' LIMIT 1'
    );
    if (found.rows.length > 0) {
      if (String(found.rows[0][0]) !== migration.checksum) {
        throw new Error('migration ' + migration.version + ' (' + migration.name + ') was edited after it was applied: checksum mismatch');
      }
      continue;
    }
    await connection.run(migration.up);
    await connection.run(
      'INSERT INTO arcod_migrations (version, checksum, applied_at) VALUES (' +
        pgLiteral('string', migration.version) + ', ' + pgLiteral('string', migration.checksum) + ', ' + Date.now() + ')'
    );
    console.log('migration applied: ' + migration.version + ' ' + migration.name);
  }
}

// LIKE reads % and _ as wildcards and a backslash as its escape, so a search
// for "100%" matched every row that starts with "100" and a row whose text
// really holds a percent sign did not have to match. The needle is escaped
// with '!' -- the character the ESCAPE clause names -- so a pattern only ever
// means the text the caller asked for.
function likeNeedle(value) {
  let out = '';
  for (const ch of String(value)) {
    if (ch === '!' || ch === '%' || ch === '_') out += '!';
    out += ch;
  }
  return out;
}

// Identifiers are model names, but they can still be reserved words or mixed
// case; double quotes stop Postgres folding them to lower case.
function pq(name) {
  return '"' + String(name).split('"').join('""') + '"';
}

function pgBytes(value) {
  return "decode('" + Buffer.from(String(value), 'utf8').toString('hex') + "', 'hex')";
}

// BYTEA arrives in the text format as backslash-x hex.
function pgTextOf(cell) {
  if (cell === null || cell === undefined) return null;
  const text = String(cell);
  if (text.slice(0, 2) === String.fromCharCode(92) + 'x') return Buffer.from(text.slice(2), 'hex').toString('utf8');
  return text;
}

function pgRowObject(columns, row) {
  const obj = {};
  for (let index = 0; index < columns.length; index += 1) {
    obj[columns[index].name] = readPgCell(columns[index].base, row[index]);
  }
  return obj;
}

class PgStore {
  constructor(url) {
    this.url = url;
    this.connection = new PgConnection(url);
    this.schema = null;
    this.reconnecting = null;
  }

  async prepare() {
    if (this.schema) {
      // Migrations are applied once; a socket that dropped afterwards only
      // needs a new connection, not another migration pass.
      await this.schema;
      if (!this.connection.alive()) await this.reconnect();
      return this.schema;
    }
    this.schema = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await this.connection.connect();
          await applyMigrations(this.connection);
          return;
        } catch (error) {
          lastError = error;
          try { await this.connection.end(); } catch (ignored) {}
          this.connection = new PgConnection(this.url);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      throw lastError;
    })().catch((error) => {
      this.schema = null;
      throw error;
    });
    return this.schema;
  }

  // One attempt per caller, shared by concurrent queries: a server that is
  // still away fails this request cleanly and the next one tries again.
  async reconnect() {
    if (this.reconnecting) return await this.reconnecting;
    this.reconnecting = (async () => {
      try {
        await this.connection.connect();
      } finally {
        this.reconnecting = null;
      }
    })();
    return await this.reconnecting;
  }

  async query(sql) {
    await this.prepare();
    return this.connection.run(sql);
  }

  async set(key, value, ttlMs) {
    const expiresAt = Date.now() + Number(ttlMs || 0);
    await this.query(
      'INSERT INTO arcod_kv (k, v, expires_at) VALUES (' + pgLiteral('string', key) + ', ' + pgBytes(value) + ', ' + expiresAt + ') ' +
      'ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at'
    );
    return 'OK';
  }

  async get(key) {
    const found = await this.query(
      'SELECT v FROM arcod_kv WHERE k = ' + pgLiteral('string', key) + ' AND expires_at > ' + Date.now() + ' LIMIT 1'
    );
    if (found.rows.length === 0) return null;
    return pgTextOf(found.rows[0][0]);
  }

  async del(key) {
    const result = await this.query('DELETE FROM arcod_kv WHERE k = ' + pgLiteral('string', key));
    return result.affected;
  }

  // ---------- typed entity operations ----------

  async entityFetch(table, columns, id) {
    const names = columns.map((c) => pq(c.name)).join(', ');
    const found = await this.query('SELECT ' + names + ' FROM ' + pq(table) + ' WHERE ' + pq('id') + ' = ' + pgLiteral('string', String(id)) + ' LIMIT 1');
    if (found.rows.length === 0) return null;
    return pgRowObject(columns, found.rows[0]);
  }

  async entityInsert(table, columns, record) {
    const names = columns.map((c) => pq(c.name)).join(', ');
    const values = columns.map((c) => pgLiteral(c.base, record[c.name])).join(', ');
    try {
      await this.query('INSERT INTO ' + pq(table) + ' (' + names + ') VALUES (' + values + ')');
    } catch (error) {
      if (pgIsUnique(error)) throw new ArcodError('Conflict');
      throw error;
    }
  }

  async entityUpdate(table, columns, id, patch) {
    const current = await this.entityFetch(table, columns, id);
    if (current == null) throw new ArcodError('NotFound');
    const next = Object.assign({}, current, patch || {});
    const set = columns.map((c) => pq(c.name) + ' = ' + pgLiteral(c.base, next[c.name])).join(', ');
    try {
      await this.query('UPDATE ' + pq(table) + ' SET ' + set + ' WHERE ' + pq('id') + ' = ' + pgLiteral('string', String(id)));
    } catch (error) {
      if (pgIsUnique(error)) throw new ArcodError('Conflict');
      throw error;
    }
    return next;
  }

  // Same answer as the mysql store: the affected count tells io.remove whether
  // the row existed, so a missing id is not a silent success.
  async entityRemove(table, columns, id) {
    const result = await this.query('DELETE FROM ' + pq(table) + ' WHERE ' + pq('id') + ' = ' + pgLiteral('string', String(id)));
    return result.affected || 0;
  }

  // COUNT(*) with the same predicates find builds; postgres returns bigint
  // as text, so the cell is coerced to a number here.
  async entityCount(table, columns, query) {
    const opts = query || {};
    const where = [];
    for (const [field, cond] of Object.entries(opts.where || {})) {
      const col = columns.find((c) => c.name === field);
      if (!col) throw new ArcodError('Invalid', { message: 'where: unknown field "' + field + '"; declared: ' + columns.map((c) => c.name).join(', ') });
      where.push(...this.whereClauses(col, cond));
    }
    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    const found = await this.query('SELECT COUNT(*) AS n FROM ' + pq(table) + whereSql);
    const row = found.rows && found.rows[0];
    const value = row ? (Array.isArray(row) ? row[0] : row.n) : 0;
    return Number(value) || 0;
  }

  // SUM/AVG/MIN/MAX over one quoted column with the same predicates count
  // builds: one statement, no rows, so a report never walks the table. An
  // unknown op or a non-numeric cell is Invalid, never a quiet undefined.
  async entityAggregate(table, columns, query) {
    const opts = query || {};
    const field = String(opts.field || '');
    const op = String(opts.op || '');
    const fn = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[op];
    if (!fn) throw new ArcodError('Invalid', { message: 'aggregate: unknown op \"' + op + '\"; use sum, avg, min or max' });
    const col = columns.find((c) => c.name === field);
    if (!col) throw new ArcodError('Invalid', { message: 'aggregate: unknown field \"' + field + '\"' });
    if (!['int', 'float', 'number', 'decimal'].includes(col.base)) {
      throw new ArcodError('Invalid', { message: 'aggregate: field ' + JSON.stringify(field) + ' is not numeric' });
    }
    const where = [];
    for (const [name, cond] of Object.entries(opts.where || {})) {
      const target = columns.find((c) => c.name === name);
      if (!target) throw new ArcodError('Invalid', { message: 'where: unknown field "' + name + '"; declared: ' + columns.map((c) => c.name).join(', ') });
      where.push(...this.whereClauses(target, cond));
    }
    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    const found = await this.query('SELECT ' + fn + '(' + pq(field) + ') AS v FROM ' + pq(table) + whereSql);
    const row = found.rows && found.rows[0];
    const value = row ? (Array.isArray(row) ? row[0] : row.v) : null;
    if (value === null || value === undefined) return op === 'sum' ? 0 : null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new ArcodError('Invalid', { message: 'aggregate: field \"' + field + '\" is not numeric' });
    return number;
  }

  async entityFind(table, columns, query) {
    const opts = query || {};
    const requested = Number(opts.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;
    const order = parseOrder(opts.order);
    for (const rule of order) {
      if (!columns.some((c) => c.name === rule.field)) {
        throw new ArcodError('Invalid', { message: 'order: unknown field "' + rule.field + '"; declared: ' + columns.map((c) => c.name).join(', ') });
      }
    }

    const where = [];
    for (const [field, cond] of Object.entries(opts.where || {})) {
      const col = columns.find((c) => c.name === field);
      if (!col) throw new ArcodError('Invalid', { message: 'where: unknown field "' + field + '"; declared: ' + columns.map((c) => c.name).join(', ') });
      where.push(...this.whereClauses(col, cond));
    }

    const at = opts.cursor ? decodeCursor(opts.cursor) : null;
    // A cursor from another order (or a corrupt one) used to vanish as if it
    // were no cursor at all: the query answered page one again and a client
    // that follows next looped forever. The shape is checked, not assumed.
    if (opts.cursor && (!at || !Array.isArray(at.v) || at.v.length !== order.length)) {
      throw new ArcodError('Invalid', {
      message: 'cursor: not a page of this order (expected ' + order.length + ' sort value' + (order.length === 1 ? '' : 's') + '); ask for the first page with this order',
      });
    }
    if (at) {
      // The values were spelled by the store that minted the cursor; comparing
      // another store's spelling would answer a silently wrong page.
      if (at.s && at.s !== 'postgres') {
        throw new ArcodError('Invalid', { message: 'cursor: issued by the ' + at.s + ' store; ask for the first page here' });
      }
      where.push(this.keysetClause(columns, order, at.v, at.id));
    }

    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    // Postgres already sorts NULL last on ASC and first on DESC, and kv
    // follows that comparator. The rank is spelled anyway so the order is
    // a contract of this emitter and not a default of one dialect;
    // keysetClause names the same rank.
    const orderSql = order
      .map((r) => '(' + pq(r.field) + ' IS NULL) ' + (r.dir < 0 ? 'DESC' : 'ASC')
        + ', ' + pq(r.field) + ' ' + (r.dir < 0 ? 'DESC' : 'ASC'))
      .join(', ') + ', ' + pq('id') + ' ASC';
    const names = columns.map((c) => pq(c.name)).join(', ');

    const found = await this.query('SELECT ' + names + ' FROM ' + pq(table) + whereSql + ' ORDER BY ' + orderSql + ' LIMIT ' + (limit + 1));
    const items = found.rows.map((row) => pgRowObject(columns, row));
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    let next = null;
    if (hasMore && page.length > 0) {
      const tail = page[page.length - 1];
      next = encodeCursor(order.map((r) => (tail[r.field] == null ? null : tail[r.field])), tail.id, 'postgres');
    }
    return { items: page, next };
  }

  whereClauses(col, cond) {
    const clauses = [];
    const ops = (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) ? cond : { eq: cond };
    for (const [op, value] of Object.entries(ops)) {
      const colSql = pq(col.name);
      if (!['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(op)) {
        throw new ArcodError('Invalid', { message: 'unknown where operator "' + op + '"' });
      }
      // CAST a moment to text and every store spells it its own way: Postgres
      // writes "2026-01-01 00:00:00", MySQL "2026-01-01 00:00:00.000" and kv
      // "2026-01-01T00:00:00Z", so the same contains found different rows. A
      // moment has an order; a range names the window without guessing a
      // spelling.
      if (op === 'contains' && col.base === 'datetime') {
        throw new ArcodError('Invalid', {
          message: 'where "contains" on "' + col.name + '" searches text, and a datetime is spelled differently by each store; use gt/gte/lt/lte',
        });
      }
      // A bytea cast to text is the escape "\x6869", while kv holds the bytes
      // and MySQL the raw BLOB, and NUMERIC(30,6) prints "1.500000" where kv
      // holds 1.5: there is no text form both stores share, so contains on
      // bytes and on a non-integer number is refused.
      if (op === 'contains' && (col.base === 'bytes' || col.base === 'decimal' || col.base === 'float' || col.base === 'number')) {
        throw new ArcodError('Invalid', {
          message: col.base === 'bytes'
            ? 'where "contains" on "' + col.name + '" needs text, and a bytes field has none: kv holds the bytes, MySQL the raw BLOB and Postgres a bytea escape; compare bytes with eq/ne/in'
            : 'where "contains" on "' + col.name + '" searches text, and a ' + col.base + ' column has no stable text: each store picks its own scale and exponent; compare numbers with eq/ne/in or a range',
        });
      }
      // A non-list under "in" used to fall through the chain: the clause
      // vanished and the query returned the whole table. An empty list is a
      // real filter that matches nothing, not "IN ()" (a syntax error).
      if (value === null && op !== 'in') {
        throw new ArcodError('Invalid', { message: 'where "' + op + '" on "' + col.name + '" compares with null; a null never matches, use a concrete value' });
      }
      if (op === 'in') {
        if (!Array.isArray(value)) {
          throw new ArcodError('Invalid', {
            message: 'where "in" on "' + col.name + '" needs a list, got ' + (value === null ? 'null' : typeof value),
          });
        }
        if (value.length === 0) {
          clauses.push('1 = 0');
          continue;
        }
      }
      if (op === 'eq') clauses.push(colSql + ' = ' + pgLiteral(col.base, value));
      else if (op === 'ne') clauses.push(colSql + ' <> ' + pgLiteral(col.base, value));
      else if (op === 'in' && Array.isArray(value)) clauses.push(colSql + ' IN (' + value.map((v) => pgLiteral(col.base, v)).join(', ') + ')');
      else if (op === 'gt') clauses.push(colSql + ' > ' + pgLiteral(col.base, value));
      else if (op === 'gte') clauses.push(colSql + ' >= ' + pgLiteral(col.base, value));
      else if (op === 'lt') clauses.push(colSql + ' < ' + pgLiteral(col.base, value));
      else if (op === 'lte') clauses.push(colSql + ' <= ' + pgLiteral(col.base, value));
      // postgres has no integer ~~ unknown: a LIKE on a non-text column was a
      // 42883 error. The cast keeps contains working for any declared field.
      else if (op === 'contains') clauses.push('CAST(' + colSql + ' AS text) LIKE ' + pgLiteral('string', '%' + likeNeedle(value) + '%') + " ESCAPE '!'");
    }
    return clauses;
  }

  keysetClause(columns, order, values, id) {
    const terms = [];
    const eqs = [];
    for (let index = 0; index < order.length; index += 1) {
      const col = columns.find((c) => c.name === order[index].field);
      // entityFind rejects an unknown order field before it builds a cursor,
      // so this is unreachable through the HTTP surface. Skipping the term
      // would be worse than a 500: values is built from the same order, and
      // a dropped term pages over rows the caller already saw.
      if (!col) throw new ArcodError('Invalid', { message: 'order: unknown field "' + order[index].field + '"' });
      const rule = order[index];
      const colSql = pq(rule.field);
      const value = values[index];
      const literalValue = pgLiteral(col.base, value);
      const prefix = eqs.length > 0 ? eqs.join(' AND ') + ' AND ' : '';
      // col > NULL is NULL and never true, so a boundary beside a NULL
      // dropped the whole null tail: the cursor carried it but no term
      // matched it. The rank decides instead. A null boundary on DESC
      // (NULL first) is followed by every non-null row; a non-null
      // boundary on ASC (NULL last) is followed by the null rows before
      // the larger values. Two null boundaries tie and id continues.
      if (value === null || value === undefined) {
        if (rule.dir < 0) terms.push(prefix + colSql + ' IS NOT NULL');
      } else if (rule.dir < 0) {
        terms.push(prefix + colSql + ' < ' + literalValue);
      } else {
        terms.push(prefix + '((' + colSql + ' IS NULL) OR ' + colSql + ' > ' + literalValue + ')');
      }
      eqs.push(colSql + ' IS NOT DISTINCT FROM ' + literalValue);
    }
    terms.push((eqs.length > 0 ? eqs.join(' AND ') + ' AND ' : '') + pq('id') + ' > ' + pgLiteral('string', String(id)));
    return '(' + terms.join(' OR ') + ')';
  }

  async claim(key) {
    const result = await this.query(
      'INSERT INTO arcod_kv (k, v, expires_at) VALUES (' + pgLiteral('string', key) + ', ' + pgBytes('1') + ', 9007199254740991) ON CONFLICT (k) DO NOTHING'
    );
    return result.affected === 1;
  }

  async exists(key) {
    const found = await this.query(
      'SELECT 1 FROM arcod_kv WHERE k = ' + pgLiteral('string', key) + ' AND expires_at > ' + Date.now() + ' LIMIT 1'
    );
    return found.rows.length > 0;
  }

  async seen(key) {
    return this.exists(key);
  }

  async scan(prefix) {
    const found = await this.query('SELECT k, v FROM arcod_kv WHERE expires_at > ' + Date.now());
    const out = [];
    for (const row of found.rows) {
      const key = pgTextOf(row[0]);
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({ key, value: pgTextOf(row[1]) });
    }
    return out;
  }

  async takeIf(messageKey, goneKey, ttlMs, expected) {
    const key = pgLiteral('string', messageKey);
    await this.query('BEGIN');
    try {
      const found = await this.query(
        'SELECT v FROM arcod_kv WHERE k = ' + key + ' AND expires_at > ' + Date.now() + ' FOR UPDATE'
      );
      if (found.rows.length === 0 || pgTextOf(found.rows[0][0]) !== String(expected)) {
        await this.query('ROLLBACK');
        return false;
      }
      await this.query('DELETE FROM arcod_kv WHERE k = ' + key);
      await this.markGone(goneKey, ttlMs);
      await this.query('COMMIT');
      return true;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async take(messageKey, goneKey, ttlMs, atomic) {
    const key = pgLiteral('string', messageKey);
    await this.query('BEGIN');
    try {
      const found = await this.query(
        'SELECT v FROM arcod_kv WHERE k = ' + key + ' AND expires_at > ' + Date.now() + ' FOR UPDATE'
      );
      if (found.rows.length > 0) {
        const value = pgTextOf(found.rows[0][0]);
        await this.query('DELETE FROM arcod_kv WHERE k = ' + key);
        await this.markGone(goneKey, ttlMs);
        await this.query('COMMIT');
        return { state: 'ok', value };
      }
      const gone = await this.query(
        'SELECT 1 FROM arcod_kv WHERE k = ' + pgLiteral('string', goneKey) + ' AND expires_at > ' + Date.now() + ' LIMIT 1'
      );
      await this.query('DELETE FROM arcod_kv WHERE k = ' + key);
      await this.query('COMMIT');
      return { state: gone.rows.length > 0 ? 'gone' : 'missing' };
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async markGone(goneKey, ttlMs) {
    const expiresAt = Date.now() + Number(ttlMs || 0);
    await this.query(
      'INSERT INTO arcod_kv (k, v, expires_at) VALUES (' + pgLiteral('string', goneKey) + ', ' + pgBytes('1') + ', ' + expiresAt + ') ' +
      'ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at'
    );
  }

  async rollback() {
    try {
      await this.query('ROLLBACK');
    } catch (ignored) {}
  }

  async begin() {
    await this.query('BEGIN');
  }

  async commit() {
    await this.query('COMMIT');
  }

  async outboxAppend(id, topic, payload) {
    await this.query(
      'INSERT INTO arcod_outbox (id, topic, payload, created_at) VALUES (' +
      pgLiteral('string', String(id)) + ', ' + pgLiteral('string', String(topic)) + ', ' + pgLiteral('string', String(payload)) + ', ' + Date.now() + ')'
    );
    return true;
  }

  async outboxPending(limit) {
    const found = await this.query(
      'SELECT id, topic, payload FROM arcod_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT ' + Number(limit || 100)
    );
    return found.rows.map((row) => ({ id: String(row[0]), topic: String(row[1]), payload: String(row[2]) }));
  }

  async outboxMark(id) {
    await this.query('UPDATE arcod_outbox SET published_at = ' + Date.now() + ' WHERE id = ' + pgLiteral('string', String(id)));
    return true;
  }

  async ping() {
    await this.query('SELECT 1');
    return 'PONG';
  }
}
`;
