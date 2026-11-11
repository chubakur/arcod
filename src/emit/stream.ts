// Vendored RFC 6455 server for the stream capability. No package, no CDN:
// the emitted service must run from a single file.
//
// Transport is chosen by the environment: with no redis binding events stay
// in-process (memory driver); with `bind stream -> redis(...)` every replica
// publishes and subscribes through the broker, so a websocket client may sit
// on any replica and still see every event.
export const STREAM_SOURCE = String.raw`// ---------- stream (websocket) ----------
// A server, not a client: the browser already speaks this protocol.
// RFC 6455 handshake, text frames, ping/pong and close. Vendored so the
// emitted service has no dependencies and no package was chosen for the user.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/ws';
const WS_MAX_PAYLOAD = 65536;
const WS_MAX_CLIENTS = 5000;
const WS_TOPICS = new Map();
const STREAM_CHANNEL = 'arcod:stream:';
const STREAM_REDIS_URL = String(process.env.STREAM_REDIS_URL || '');

function wsAccept(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function wsFrame(opcode, payload) {
  const length = payload.length;
  let head;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

function wsSend(client, opcode, text) {
  if (!client || client.socket.destroyed || !client.socket.writable) return false;
  try {
    client.socket.write(wsFrame(opcode, Buffer.from(String(text), 'utf8')));
    return true;
  } catch {
    return false;
  }
}

function wsDeliver(topic, text) {
  const set = WS_TOPICS.get(String(topic));
  if (!set || set.size === 0) return 0;
  let sent = 0;
  for (const client of set) {
    if (wsSend(client, 0x1, text)) sent += 1;
  }
  return sent;
}

function wsLeaveTopic(client) {
  const set = WS_TOPICS.get(client.topic);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    WS_TOPICS.delete(client.topic);
    if (streamPub) streamPub.unsubscribe(STREAM_CHANNEL + client.topic);
  }
}

function wsDrop(client) {
  wsLeaveTopic(client);
  client.socket.destroy();
}

function wsRead(client, chunk) {
  client.buf = Buffer.concat([client.buf, chunk]);
  for (;;) {
    const buf = client.buf;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (length > WS_MAX_PAYLOAD) return wsDrop(client);
    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) return;
    const mask = masked ? buf.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    client.buf = buf.subarray(offset + length);
    if (opcode === 0x8) {
      wsSend(client, 0x8, '');
      wsDrop(client);
      return;
    }
    if (opcode === 0x9) {
      wsSend(client, 0xa, payload.toString('utf8'));
      continue;
    }
    // Client messages are ignored on purpose: this channel is server to
    // client. Commands stay on http, where they have statuses and limits.
  }
}

function wsUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== WS_PATH) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const topic = String(url.searchParams.get('topic') || '').slice(0, 200);
  if (!key || !topic) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const set = WS_TOPICS.get(topic) || new Set();
  if (set.size >= WS_MAX_CLIENTS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n',
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);
  const client = { socket, buf: Buffer.alloc(0), topic };
  set.add(client);
  WS_TOPICS.set(topic, set);
  if (set.size === 1 && streamPub) streamPub.subscribe(STREAM_CHANNEL + topic);
  socket.on('data', (chunk) => wsRead(client, chunk));
  socket.on('close', () => wsLeaveTopic(client));
  socket.on('error', () => { wsLeaveTopic(client); socket.destroy(); });
  wsSend(client, 0x1, JSON.stringify({ type: 'ready', topic }));
  if (head && head.length > 0) wsRead(client, head);
}

// ---------- redis pub/sub (push protocol, own minimal RESP) ----------

function createStreamPubSub(url) {
  const match = /^redis:\/\/([^:/]+)(?::([0-9]+))?$/.exec(url);
  const host = match ? match[1] : 'redis';
  const port = match && match[2] ? Number(match[2]) : 6379;
  const subscriptions = new Map();
  const state = {
    socket: null,
    buffer: Buffer.alloc(0),
    connecting: null,
  };

  function encode(...args) {
    const parts = ['*' + args.length + '\r\n'];
    for (const arg of args) {
      const value = String(arg);
      parts.push('$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n');
    }
    return parts.join('');
  }

  // Only what pub/sub needs: status lines, errors, integers and bulk
  // strings. Pushes are either a message (3 bulks) or a subscribe/unsubscribe
  // confirmation (bulk, bulk, integer) — both are 3-field arrays.
  function parsePush(buf) {
    if (buf.length < 1 || buf[0] !== 0x2a) return null; // '*'
    const firstEnd = buf.indexOf('\r\n');
    if (firstEnd === -1) return null;
    const count = Number(buf.toString('utf8', 1, firstEnd));
    if (count !== 3) return null;
    let offset = firstEnd + 2;
    const fields = [];
    for (let i = 0; i < 3; i += 1) {
      if (buf[offset] === 0x24) {
        const lenEnd = buf.indexOf('\r\n', offset);
        if (lenEnd === -1) return null;
        const len = Number(buf.toString('utf8', offset + 1, lenEnd));
        const start = lenEnd + 2;
        if (buf.length < start + len + 2) return null;
        fields.push(buf.toString('utf8', start, start + len));
        offset = start + len + 2;
      } else if (i === 2 && buf[offset] === 0x3a) {
        const intEnd = buf.indexOf('\r\n', offset);
        if (intEnd === -1) return null;
        fields.push(Number(buf.toString('utf8', offset + 1, intEnd)));
        offset = intEnd + 2;
      } else {
        return null;
      }
    }
    return { fields, next: offset };
  }

  function onData(chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      const parsed = parsePush(state.buffer);
      if (!parsed) break;
      state.buffer = state.buffer.subarray(parsed.next);
      if (parsed.fields[0] === 'message') {
        wsDeliver(String(parsed.fields[1]).slice(STREAM_CHANNEL.length), parsed.fields[2]);
      }
    }
  }

  function connect() {
    if (state.socket && !state.socket.destroyed) return Promise.resolve();
    if (state.connecting) return state.connecting;
    state.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        state.connecting = null;
        resolve();
      });
      socket.on('data', onData);
      socket.on('error', (err) => { state.connecting = null; reject(err); });
      socket.on('close', () => {
        state.socket = null;
        // Re-subscribe everything on reconnect: delivery resumes where the
        // topics left off, sockets still get their events.
        if ([...subscriptions.values()].some((count) => count > 0)) {
          setTimeout(() => connect().catch(() => {}), 500);
        }
      });
      state.socket = socket;
    });
    return state.connecting;
  }

  async function subscribe(channel) {
    const count = subscriptions.get(channel) || 0;
    subscriptions.set(channel, count + 1);
    if (count > 0) return;
    try {
      await connect();
      state.socket.write(encode('SUBSCRIBE', channel));
    } catch {
      subscriptions.set(channel, 0);
    }
  }

  async function unsubscribe(channel) {
    const count = (subscriptions.get(channel) || 0) - 1;
    subscriptions.set(channel, Math.max(0, count));
    if (count > 0) return;
    if (state.socket && !state.socket.destroyed) {
      try { state.socket.write(encode('UNSUBSCRIBE', channel)); } catch {}
    }
  }

  function publish(channel, text) {
    // Fire and forget: the broker fans out to every replica, including us —
    // our own delivery comes back through the subscription like any other.
    connect()
      .then(() => state.socket.write(encode('PUBLISH', channel, text)))
      .catch(() => {});
  }

  connect().catch(() => {});
  return { subscribe, unsubscribe, publish };
}

const streamPub = STREAM_REDIS_URL ? createStreamPubSub(STREAM_REDIS_URL) : null;

// io.publish(topic, message) lands here. In memory mode it delivers
// directly; with a broker the message comes back through our own
// subscription like any replica's, so local clients are not delivered
// twice. The return value is how many local clients are attached.
function wsPublish(topic, message) {
  const text = JSON.stringify(message === undefined ? null : message);
  const set = WS_TOPICS.get(String(topic));
  const attached = set ? set.size : 0;
  if (streamPub) streamPub.publish(STREAM_CHANNEL + topic, text);
  else wsDeliver(String(topic), text);
  return attached;
}

const wsKeepalive = setInterval(() => {
  for (const set of WS_TOPICS.values()) {
    for (const client of set) wsSend(client, 0x9, 'p');
  }
}, 30000);
wsKeepalive.unref();
`;
