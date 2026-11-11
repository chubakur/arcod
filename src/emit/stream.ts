// Vendored RFC 6455 server for the stream capability. No package, no CDN:
// the emitted service must run from a single file.
export const STREAM_SOURCE = String.raw`// ---------- stream (websocket) ----------
// A server, not a client: the browser already speaks this protocol.
// RFC 6455 handshake, text frames, ping/pong and close. Vendored so the
// emitted service has no dependencies and no package was chosen for the user.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/ws';
const WS_MAX_PAYLOAD = 65536;
const WS_MAX_CLIENTS = 5000;
const WS_TOPICS = new Map();

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

function wsDrop(client) {
  const set = WS_TOPICS.get(client.topic);
  if (set) {
    set.delete(client);
    if (set.size === 0) WS_TOPICS.delete(client.topic);
  }
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
  socket.on('data', (chunk) => wsRead(client, chunk));
  socket.on('close', () => { set.delete(client); if (set.size === 0) WS_TOPICS.delete(topic); });
  socket.on('error', () => { set.delete(client); socket.destroy(); });
  wsSend(client, 0x1, JSON.stringify({ type: 'ready', topic }));
  if (head && head.length > 0) wsRead(client, head);
}

// io.publish(topic, message) lands here. Returns how many clients heard it,
// which is what the body can assert on in a test.
function wsPublish(topic, message) {
  const set = WS_TOPICS.get(String(topic));
  if (!set || set.size === 0) return 0;
  const text = JSON.stringify(message === undefined ? null : message);
  let sent = 0;
  for (const client of set) {
    if (wsSend(client, 0x1, text)) sent += 1;
  }
  return sent;
}

const wsKeepalive = setInterval(() => {
  for (const set of WS_TOPICS.values()) {
    for (const client of set) wsSend(client, 0x9, 'p');
  }
}, 30000);
wsKeepalive.unref();
`;
