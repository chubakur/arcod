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
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.ready = null;
    this.failed = null;
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
      const timer = setTimeout(() => reject(new Error('postgres: connect timeout')), timeoutMs || 5000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      this.ready = { resolve, reject: fail, timer };
      socket.on('error', (error) => {
        clearTimeout(timer);
        if (this.pending) this.pending.reject(error); else fail(error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const error = new Error('postgres connection closed');
        if (this.pending) this.pending.reject(error); else fail(error);
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

  failAll(error) {
    if (this.pending) { this.pending.reject(error); this.pending = null; }
    if (this.ready) { this.ready.reject(error); this.ready = null; }
    if (this.socket) this.socket.destroy();
  }

  send(type, payload) {
    const head = Buffer.alloc(5);
    head.write(type, 0);
    head.writeInt32BE(payload.length + 4, 1);
    this.socket.write(Buffer.concat([head, payload]));
  }

  onMessage(type, payload) {
    if (type === 'R') { this.onAuth(payload); return; }
    if (type === 'E') { const error = pgError(payload); this.failAll(error); return; }
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
        pending.resolve({ fields: pending.fields, rows: pending.rows });
      }
      return;
    }
    if (type === 'T') { if (this.pending) this.pending.fields = pgFields(payload); return; }
    if (type === 'D') { if (this.pending) this.pending.rows.push(pgRow(payload)); return; }
    // S/K/N/C/1/2/3/A: status, notices and command tags need no handling here.
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
      const first = Buffer.from(this.clientFirstBare, 'utf8');
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
    if (this.pending) throw new Error('postgres: query already in flight');
    return await new Promise((resolve, reject) => {
      this.pending = { resolve, reject, fields: [], rows: [] };
      this.send('Q', pgCString(sql));
    });
  }

  async run(sql) {
    return await this.query(sql);
  }

  async end() {
    if (!this.socket) return;
    this.send('X', Buffer.alloc(0));
    this.socket.end();
    this.socket = null;
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
