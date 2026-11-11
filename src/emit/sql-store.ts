// The generated service has no dependencies: this is a minimal MySQL client
// speaking the text protocol over node:net. Values travel as hex literals, so
// nothing from a request is ever concatenated into SQL unescaped.
export const SQL_STORE_SOURCE = `// ---------- mysql ----------

const SQL_SCHEMA = 'CREATE TABLE IF NOT EXISTS arcod_kv (k VARBINARY(255) NOT NULL PRIMARY KEY, v LONGBLOB NOT NULL, expires_at BIGINT NOT NULL, KEY arcod_kv_expires (expires_at)) ENGINE=InnoDB';
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
          await this.connection.run(SQL_SCHEMA);
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

  async ping() {
    await this.query('SELECT 1');
    return 'PONG';
  }
}
`;
