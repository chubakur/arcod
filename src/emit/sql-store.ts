// The generated service has no dependencies: this is a minimal MySQL client
// speaking the text protocol over node:net. Values travel as hex literals, so
// nothing from a request is ever concatenated into SQL unescaped.
export const SQL_STORE_SOURCE = `// ---------- mysql ----------

const MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS arcod_migrations (version VARCHAR(16) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at BIGINT NOT NULL) ENGINE=InnoDB';

// Applies the generated changelog deterministically. A fresh database ends in
// exactly the state the service expects; a re-run is a no-op; and a migration
// that was edited after it was applied refuses to start the service.
async function applyMigrations(connection) {
  await connection.run(MIGRATIONS_TABLE);
  for (const migration of MIGRATIONS) {
    const found = await connection.run(
      'SELECT checksum FROM arcod_migrations WHERE version = ' + literal(hexOf(migration.version)) + ' LIMIT 1'
    );
    if (found.rows.length > 0) {
      const applied = utf8Of(found.rows[0][0]);
      if (applied !== migration.checksum) {
        throw new Error('migration ' + migration.version + ' (' + migration.name + ') was edited after it was applied: checksum mismatch');
      }
      continue;
    }
    await connection.run(migration.up);
    await connection.run(
      'INSERT INTO arcod_migrations (version, checksum, applied_at) VALUES (' + literal(hexOf(migration.version)) + ', ' + literal(hexOf(migration.checksum)) + ', ' + Date.now() + ')'
    );
    console.log('migration applied: ' + migration.version + ' ' + migration.name);
  }
}

const CLIENT_FLAGS = 0x00000001 | 0x00000004 | 0x00000008 | 0x00000200 | 0x00002000 | 0x00008000 | 0x00080000;

function hexOf(value) {
  return Buffer.from(String(value), 'utf8').toString('hex');
}

function literal(value) {
  return "UNHEX('" + value + "')";
}

function utf8Of(cell) {
  return cell == null ? null : cell.toString('utf8');
}

// ---------- typed entity codec ----------
//
// Records live in real tables when the driver is sql. A value is written as a
// literal of its column type and read back through the same base type, so a
// field can never drift between schema and runtime.

function normalizeDateTime(value) {
  return String(value).replace('T', ' ').replace(/Z$/, '');
}

function isoDateTime(value) {
  return String(value).replace(' ', 'T') + 'Z';
}

function sqlLiteral(base, value) {
  if (value === null || value === undefined) return 'NULL';
  if (base === 'bool' || base === 'boolean') return value ? '1' : '0';
  if (base === 'int' || base === 'float' || base === 'number' || base === 'decimal') {
    return typeof value === 'number' ? String(value) : literal(hexOf(String(value)));
  }
  if (base === 'datetime') return literal(hexOf(normalizeDateTime(value)));
  if (base === 'json' || base === 'list' || base === 'map') return literal(hexOf(JSON.stringify(value)));
  return literal(hexOf(String(value)));
}

function readCell(base, cell) {
  if (cell === null || cell === undefined) return null;
  const text = cell.toString('utf8');
  if (base === 'int' || base === 'float' || base === 'number' || base === 'decimal') {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (base === 'bool' || base === 'boolean') return text === '1';
  if (base === 'datetime') return isoDateTime(text);
  if (base === 'json' || base === 'list' || base === 'map') {
    try { return JSON.parse(text); } catch (ignored) { return null; }
  }
  return text;
}

function rowToObject(columns, row) {
  const obj = {};
  for (let index = 0; index < columns.length; index += 1) {
    obj[columns[index].name] = readCell(columns[index].base, row[index]);
  }
  return obj;
}

// Model identifiers are safe, but they can collide with MySQL reserved words
// (a record type named Order becomes table "order"). Quote every identifier;
// String.fromCharCode keeps the backtick out of the template literal source.
function q(name) {
  return String.fromCharCode(96) + String(name) + String.fromCharCode(96);
}


function xorBytes(left, right) {
  const out = Buffer.alloc(left.length);
  for (let index = 0; index < left.length; index += 1) {
    out[index] = left[index] ^ right[index % right.length];
  }
  return out;
}

function readLenencInt(buf, offset) {
  const first = buf[offset];
  if (first < 0xfb) return { value: first, next: offset + 1 };
  if (first === 0xfb) return { value: null, next: offset + 1 };
  if (first === 0xfc) return { value: buf.readUIntLE(offset + 1, 2), next: offset + 3 };
  if (first === 0xfd) return { value: buf.readUIntLE(offset + 1, 3), next: offset + 4 };
  return { value: Number(buf.readBigUInt64LE(offset + 1)), next: offset + 9 };
}

function readLenencBytes(buf, offset) {
  const first = buf[offset];
  if (first === 0xfb) return { value: null, next: offset + 1 };
  let length = first;
  let start = offset + 1;
  if (first === 0xfc) {
    length = buf.readUIntLE(offset + 1, 2);
    start = offset + 3;
  } else if (first === 0xfd) {
    length = buf.readUIntLE(offset + 1, 3);
    start = offset + 4;
  } else if (first === 0xfe) {
    length = Number(buf.readBigUInt64LE(offset + 1));
    start = offset + 9;
  }
  return { value: buf.subarray(start, start + length), next: start + length };
}

function mysqlError(packet) {
  const code = packet.readUInt16LE(1);
  const message = packet.subarray(3).toString('utf8').replace(/^#..../, '');
  return new Error('mysql ' + code + ': ' + message);
}

class MySqlConnection {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 3306);
    this.user = decodeURIComponent(parsed.username || 'root');
    this.password = decodeURIComponent(parsed.password || '');
    this.database = decodeURIComponent(parsed.pathname.replace(/^[/]/, '')) || 'arcod';
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.pending = null;
    this.connecting = null;
    this.ready = false;
    this.socket = null;
    this.salt = Buffer.alloc(0);
    this.plugin = 'mysql_native_password';
  }

  reset() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (ignored) {}
    }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.connecting = null;
    this.ready = false;
  }

  pump() {
    while (this.pending && this.buffer.length >= 4) {
      const length = this.buffer.readUIntLE(0, 3);
      if (this.buffer.length < 4 + length) return;
      const packet = this.buffer.subarray(4, 4 + length);
      this.seq = this.buffer[3] + 1;
      this.buffer = this.buffer.subarray(4 + length);
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve(packet);
    }
  }

  readPacket() {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.pump();
    });
  }

  writePacket(payload) {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = this.seq % 256;
    this.seq = (this.seq + 1) % 256;
    this.socket.write(Buffer.concat([header, payload]));
  }

  async ensure() {
    if (this.ready) return;
    if (!this.connecting) {
      this.connecting = this.handshake().then(() => {
        this.ready = true;
      }).catch((error) => {
        this.reset();
        throw error;
      });
    }
    await this.connecting;
    this.connecting = null;
  }

  async handshake() {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.pump();
      });
      socket.on('close', () => {
        this.ready = false;
        this.connecting = null;
        if (this.pending) {
          const waiter = this.pending;
          this.pending = null;
          waiter.reject(new Error('mysql connection closed'));
        }
      });
      socket.on('error', () => {});
    });

    const greeting = await this.readPacket();
    if (greeting[0] === 0xff) throw mysqlError(greeting);

    let offset = 1;
    offset = greeting.indexOf(0, offset) + 1;
    offset += 4;
    const salt1 = greeting.subarray(offset, offset + 8);
    offset += 8 + 1;
    const capsLow = greeting.readUInt16LE(offset);
    offset += 2 + 1 + 2;
    const capsHigh = greeting.readUInt16LE(offset);
    offset += 2;
    const caps = capsLow | (capsHigh << 16);
    const authLength = greeting[offset];
    offset += 1 + 10;
    const salt2Length = Math.max(13, authLength - 8);
    const salt2 = greeting.subarray(offset, offset + salt2Length - 1);
    offset += salt2Length;

    let plugin = 'mysql_native_password';
    if (caps & 0x00080000) {
      const end = greeting.indexOf(0, offset);
      plugin = greeting.subarray(offset, end < 0 ? greeting.length : end).toString('utf8') || plugin;
    }
    this.salt = Buffer.concat([salt1, salt2]);
    this.plugin = plugin;

    const auth = this.scramble(plugin);
    const header = Buffer.alloc(4 + 4 + 1 + 23);
    header.writeUInt32LE(CLIENT_FLAGS, 0);
    header.writeUInt32LE(0x01000000, 4);
    header[8] = 45;
    this.seq = 1;
    this.writePacket(Buffer.concat([
      header,
      Buffer.from(this.user, 'utf8'), Buffer.from([0]),
      Buffer.from([auth.length]), auth,
      Buffer.from(this.database, 'utf8'), Buffer.from([0]),
      Buffer.from(plugin, 'utf8'), Buffer.from([0]),
    ]));

    let reply = await this.readPacket();
    for (let step = 0; step < 4; step += 1) {
      if (reply[0] === 0x00 || reply[0] === 0xff) break;
      if (reply[0] === 0xfe) {
        const end = reply.indexOf(0, 1);
        const switched = reply.subarray(1, end < 0 ? reply.length : end).toString('utf8') || 'mysql_native_password';
        this.plugin = switched;
        this.salt = reply.subarray(end + 1, end + 1 + 20);
        this.writePacket(this.scramble(switched));
        reply = await this.readPacket();
        continue;
      }
      if (reply[0] === 0x01 && reply[1] === 0x03) {
        reply = await this.readPacket();
        continue;
      }
      if (reply[0] === 0x01 && reply[1] === 0x04) {
        this.writePacket(Buffer.from([0x02]));
        const key = await this.readPacket();
        const pem = key[0] === 0x01 ? key.subarray(1) : key;
        const publicKey = createPublicKey(pem.toString('utf8'));
        const secret = Buffer.from(this.password + String.fromCharCode(0), 'utf8');
        const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, xorBytes(secret, this.salt));
        this.writePacket(encrypted);
        reply = await this.readPacket();
        continue;
      }
      throw new Error('mysql: unexpected auth packet ' + reply[0]);
    }
    if (reply[0] === 0xff) throw mysqlError(reply);
    if (reply[0] !== 0x00) throw new Error('mysql: authentication failed');
  }

  scramble(plugin) {
    const password = Buffer.from(this.password, 'utf8');
    if (password.length === 0) return Buffer.alloc(0);
    if (plugin === 'caching_sha2_password') {
      const stage1 = createHash('sha256').update(password).digest();
      const stage2 = createHash('sha256').update(stage1).digest();
      const stage3 = createHash('sha256').update(Buffer.concat([stage2, this.salt])).digest();
      return xorBytes(stage1, stage3);
    }
    const stage1 = createHash('sha1').update(password).digest();
    const stage2 = createHash('sha1').update(stage1).digest();
    const stage3 = createHash('sha1').update(Buffer.concat([this.salt, stage2])).digest();
    return xorBytes(stage1, stage3);
  }

  async run(sql) {
    if (!this.socket) throw new Error('mysql: not connected');
    this.seq = 0;
    this.writePacket(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]));
    const first = await this.readPacket();
    if (first[0] === 0xff) throw mysqlError(first);
    if (first[0] === 0x00) return { rows: [], affected: readLenencInt(first, 1).value || 0 };
    const count = readLenencInt(first, 0).value;
    for (let index = 0; index < count; index += 1) await this.readPacket();
    await this.readPacket();
    const rows = [];
    while (true) {
      const packet = await this.readPacket();
      if (packet[0] === 0xff) throw mysqlError(packet);
      if (packet[0] === 0xfe && packet.length < 9) break;
      const row = [];
      let at = 0;
      for (let index = 0; index < count; index += 1) {
        const cell = readLenencBytes(packet, at);
        at = cell.next;
        row.push(cell.value);
      }
      rows.push(row);
    }
    return { rows, affected: 0 };
  }
}

class SqlStore {
  constructor(url) {
    this.connection = new MySqlConnection(url);
    this.schema = null;
  }

  async prepare() {
    if (this.schema) return this.schema;
    this.schema = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await this.connection.ensure();
          await applyMigrations(this.connection);
          return;
        } catch (error) {
          lastError = error;
          this.connection.reset();
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

  async query(sql) {
    await this.prepare();
    return this.connection.run(sql);
  }

  async set(key, value, ttlMs) {
    const expiresAt = Date.now() + Number(ttlMs || 0);
    await this.query(
      "INSERT INTO arcod_kv (k, v, expires_at) VALUES (" + literal(hexOf(key)) + ", " + literal(hexOf(value)) + ", " + expiresAt + ") " +
      "ON DUPLICATE KEY UPDATE v = VALUES(v), expires_at = VALUES(expires_at)"
    );
    return 'OK';
  }

  async get(key) {
    const found = await this.query(
      "SELECT v FROM arcod_kv WHERE k = " + literal(hexOf(key)) + " AND expires_at > " + Date.now() + " LIMIT 1"
    );
    if (found.rows.length === 0) return null;
    return utf8Of(found.rows[0][0]);
  }

  async del(key) {
    const result = await this.query("DELETE FROM arcod_kv WHERE k = " + literal(hexOf(key)));
    return result.affected;
  }

  // ---------- typed entity operations ----------

  async entityFetch(table, columns, id) {
    const names = columns.map((c) => q(c.name)).join(', ');
    const found = await this.query('SELECT ' + names + ' FROM ' + q(table) + ' WHERE ' + q('id') + ' = ' + literal(hexOf(String(id))) + ' LIMIT 1');
    if (found.rows.length === 0) return null;
    return rowToObject(columns, found.rows[0]);
  }

  async entityInsert(table, columns, record) {
    const names = columns.map((c) => q(c.name)).join(', ');
    const values = columns.map((c) => sqlLiteral(c.base, record[c.name])).join(', ');
    try {
      await this.query('INSERT INTO ' + q(table) + ' (' + names + ') VALUES (' + values + ')');
    } catch (error) {
      if (String(error && error.message).includes('mysql 1062')) throw new ArcodError('Conflict');
      throw error;
    }
  }

  async entityUpdate(table, columns, id, patch) {
    const current = await this.entityFetch(table, columns, id);
    if (current == null) throw new ArcodError('NotFound');
    const next = Object.assign({}, current, patch || {});
    const set = columns.map((c) => q(c.name) + ' = ' + sqlLiteral(c.base, next[c.name])).join(', ');
    try {
      await this.query('UPDATE ' + q(table) + ' SET ' + set + ' WHERE ' + q('id') + ' = ' + literal(hexOf(String(id))));
    } catch (error) {
      if (String(error && error.message).includes('mysql 1062')) throw new ArcodError('Conflict');
      throw error;
    }
    return next;
  }

  async entityRemove(table, columns, id) {
    await this.query('DELETE FROM ' + q(table) + ' WHERE ' + q('id') + ' = ' + literal(hexOf(String(id))));
  }

  async entityFind(table, columns, query) {
    const q = query || {};
    const requested = Number(q.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 50;
    const order = parseOrder(q.order);

    const where = [];
    for (const [field, cond] of Object.entries(q.where || {})) {
      const col = columns.find((c) => c.name === field);
      if (!col) continue;
      where.push(...this.whereClauses(col, cond));
    }

    const at = q.cursor ? decodeCursor(q.cursor) : null;
    if (at && Array.isArray(at.v) && at.v.length === order.length) {
      where.push(this.keysetClause(columns, order, at.v, at.id));
    }

    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    const orderSql = order.map((r) => q(r.field) + ' ' + (r.dir < 0 ? 'DESC' : 'ASC')).join(', ') + ', ' + q('id') + ' ASC';
    const names = columns.map((c) => q(c.name)).join(', ');

    const found = await this.query('SELECT ' + names + ' FROM ' + q(table) + whereSql + ' ORDER BY ' + orderSql + ' LIMIT ' + (limit + 1));
    const items = found.rows.map((row) => rowToObject(columns, row));
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    let next = null;
    if (hasMore && page.length > 0) {
      const tail = page[page.length - 1];
      next = encodeCursor(order.map((r) => (tail[r.field] == null ? null : tail[r.field])), tail.id);
    }
    return { items: page, next };
  }

  whereClauses(col, cond) {
    const clauses = [];
    const ops = (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) ? cond : { eq: cond };
    for (const [op, value] of Object.entries(ops)) {
      const colSql = q(col.name);
      if (op === 'eq') clauses.push(colSql + ' = ' + sqlLiteral(col.base, value));
      else if (op === 'ne') clauses.push(colSql + ' <> ' + sqlLiteral(col.base, value));
      else if (op === 'in' && Array.isArray(value)) clauses.push(colSql + ' IN (' + value.map((v) => sqlLiteral(col.base, v)).join(', ') + ')');
      else if (op === 'gt') clauses.push(colSql + ' > ' + sqlLiteral(col.base, value));
      else if (op === 'gte') clauses.push(colSql + ' >= ' + sqlLiteral(col.base, value));
      else if (op === 'lt') clauses.push(colSql + ' < ' + sqlLiteral(col.base, value));
      else if (op === 'lte') clauses.push(colSql + ' <= ' + sqlLiteral(col.base, value));
      else if (op === 'contains') clauses.push(colSql + ' LIKE ' + literal(hexOf('%' + String(value) + '%')));
    }
    return clauses;
  }

  keysetClause(columns, order, values, id) {
    const terms = [];
    const eqs = [];
    for (let index = 0; index < order.length; index += 1) {
      const col = columns.find((c) => c.name === order[index].field);
      if (!col) continue;
      const colSql = q(order[index].field);
      const cmp = order[index].dir < 0 ? '<' : '>';
      const literalValue = sqlLiteral(col.base, values[index]);
      terms.push((eqs.length > 0 ? eqs.join(' AND ') + ' AND ' : '') + colSql + ' ' + cmp + ' ' + literalValue);
      eqs.push(colSql + ' <=> ' + literalValue);
    }
    terms.push((eqs.length > 0 ? eqs.join(' AND ') + ' AND ' : '') + q('id') + ' > ' + literal(hexOf(String(id))));
    return '(' + terms.join(' OR ') + ')';
  }


  // Claiming a unique value must not race: INSERT IGNORE reports zero affected
  // rows when the key already exists, and the primary key decides the winner.
  async claim(key) {
    const result = await this.query(
      "INSERT IGNORE INTO arcod_kv (k, v, expires_at) VALUES (" + literal(hexOf(key)) + ", " + literal(hexOf('1')) + ", 9007199254740991)"
    );
    return result.affected === 1;
  }

  async exists(key) {
    const found = await this.query(
      "SELECT 1 FROM arcod_kv WHERE k = " + literal(hexOf(key)) + " AND expires_at > " + Date.now() + " LIMIT 1"
    );
    return found.rows.length > 0;
  }

  async seen(key) {
    return this.exists(key);
  }

  async scan(prefix) {
    const found = await this.query("SELECT k, v FROM arcod_kv WHERE expires_at > " + Date.now());
    const out = [];
    for (const row of found.rows) {
      const key = utf8Of(row[0]);
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({ key, value: utf8Of(row[1]) });
    }
    return out;
  }

  async takeIf(messageKey, goneKey, ttlMs, expected) {
    const key = literal(hexOf(messageKey));
    await this.query('START TRANSACTION');
    try {
      const found = await this.query(
        "SELECT v FROM arcod_kv WHERE k = " + key + " AND expires_at > " + Date.now() + " FOR UPDATE"
      );
      if (found.rows.length === 0 || utf8Of(found.rows[0][0]) !== String(expected)) {
        await this.query('ROLLBACK');
        return false;
      }
      await this.query("DELETE FROM arcod_kv WHERE k = " + key);
      await this.markGone(goneKey, ttlMs);
      await this.query('COMMIT');
      return true;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async take(messageKey, goneKey, ttlMs, atomic) {
    const key = literal(hexOf(messageKey));
    await this.query('START TRANSACTION');
    try {
      const found = await this.query(
        "SELECT v FROM arcod_kv WHERE k = " + key + " AND expires_at > " + Date.now() + " FOR UPDATE"
      );
      if (found.rows.length > 0) {
        const value = utf8Of(found.rows[0][0]);
        await this.query("DELETE FROM arcod_kv WHERE k = " + key);
        await this.markGone(goneKey, ttlMs);
        await this.query('COMMIT');
        return { state: 'ok', value };
      }
      const gone = await this.query(
        "SELECT 1 FROM arcod_kv WHERE k = " + literal(hexOf(goneKey)) + " AND expires_at > " + Date.now() + " LIMIT 1"
      );
      await this.query("DELETE FROM arcod_kv WHERE k = " + key);
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
      "INSERT INTO arcod_kv (k, v, expires_at) VALUES (" + literal(hexOf(goneKey)) + ", " + literal('1') + ", " + expiresAt + ") " +
      "ON DUPLICATE KEY UPDATE v = VALUES(v), expires_at = VALUES(expires_at)"
    );
  }

  async rollback() {
    try {
      await this.query('ROLLBACK');
    } catch (ignored) {}
  }

  async begin() {
    await this.query('START TRANSACTION');
  }

  async commit() {
    await this.query('COMMIT');
  }

  // Outbox: the body appends the event here (inside the ambient transaction, if
  // any), and the dispatcher relays it to the queue broker once the row is
  // committed. published_at is the delivery mark.
  async outboxAppend(id, topic, payload) {
    await this.query(
      'INSERT INTO arcod_outbox (id, topic, payload, created_at) VALUES (' +
      literal(hexOf(String(id))) + ', ' + literal(hexOf(String(topic))) + ', ' + literal(hexOf(String(payload))) + ', ' + Date.now() + ')'
    );
    return true;
  }

  async outboxPending(limit) {
    const found = await this.query(
      'SELECT id, topic, payload FROM arcod_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT ' + Number(limit || 100)
    );
    return found.rows.map((row) => ({ id: utf8Of(row[0]), topic: utf8Of(row[1]), payload: utf8Of(row[2]) }));
  }

  async outboxMark(id) {
    await this.query('UPDATE arcod_outbox SET published_at = ' + Date.now() + ' WHERE id = ' + literal(hexOf(String(id))));
    return true;
  }

  async ping() {
    await this.query('SELECT 1');
    return 'PONG';
  }
}
`;
