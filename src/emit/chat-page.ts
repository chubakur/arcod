// The chat layout: transcript plus a composer. It is chosen explicitly in the
// spec (layout: chat) and told which operation reads history and which sends,
// so nothing here depends on operation names.
export const CHAT_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root { color-scheme: light dark; --line: #d8dbe0; --muted: #6b7280; --accent: #2563eb; --bubble: #f3f4f6; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px 32px; display: flex; flex-direction: column; min-height: 100vh; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0; }
  .lead { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .chat { flex: 1; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; min-height: 60vh; }
  .msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 78%; border-radius: 14px; padding: 8px 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg.bot { align-self: flex-start; background: var(--bubble); }
  .msg .who { font-size: 11px; opacity: .65; margin-bottom: 2px; text-transform: lowercase; }
  .empty { color: var(--muted); font-style: italic; margin: auto; }
  .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); align-items: flex-end; }
  .composer textarea { flex: 1; min-height: 52px; max-height: 200px; resize: vertical; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: transparent; color: inherit; }
  button { font: inherit; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; }
  .status { font-size: 12px; color: var(--muted); }
  .bad { color: #b91c1c; white-space: pre-wrap; }
  .auth { display: flex; gap: 10px; margin-bottom: 12px; }
  .auth[hidden] { display: none; }
  .auth input { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
</style>
</head>
<body>
<main>
  <header>
    <h1>__TITLE__</h1>
    <span class="status" id="status"></span>
  </header>
  <p class="lead">__LEAD__</p>
  <section class="auth" id="auth" hidden>
    <input id="token" type="password" autocomplete="off" placeholder="Bearer token">
    <button type="button" id="save-token">Save</button>
  </section>
  <div class="chat">
    <div class="msgs" id="msgs"><div class="empty">Nothing here yet — send the first message.</div></div>
    <form class="composer" id="composer">
      <textarea id="text" rows="2" placeholder="Message… (Enter — send, Shift+Enter — new line)"></textarea>
      <button class="primary" id="send" type="submit">Send</button>
    </form>
  </div>
  <div class="row" style="margin-top:10px">
    <button type="button" id="reset">New conversation</button>
    <span class="status" id="conv"></span>
  </div>
</main>
<script>
var OPS = __CHAT_OPS__;
var HAS_AUTH = __HAS_AUTH__;
var TOKEN_KEY = 'arcod.token';
var CONV_KEY = 'arcod.chat.' + OPS.module;
var msgs = document.getElementById('msgs');
var form = document.getElementById('composer');
var input = document.getElementById('text');
var sendButton = document.getElementById('send');
var statusEl = document.getElementById('status');
var convEl = document.getElementById('conv');
var resetButton = document.getElementById('reset');

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
function headers() {
  var out = { 'content-type': 'application/json' };
  if (token()) out.authorization = 'Bearer ' + token();
  return out;
}
function setStatus(text) { statusEl.textContent = text || ''; }

async function request(op, values) {
  var url = op.path;
  var query = new URLSearchParams();
  var body = {};
  op.params.forEach(function (p) {
    var value = values[p.name];
    if (p.where === 'path') {
      url = url.split(':' + p.name).join(encodeURIComponent(String(value == null ? '' : value)));
    } else if (p.where === 'query') {
      if (value != null && value !== '') query.append(p.name, String(value));
    } else if (value !== undefined) {
      body[p.name] = value;
    }
  });
  if (query.toString()) url += '?' + query.toString();
  var init = { method: op.method, headers: headers() };
  if (op.method !== 'GET' && op.method !== 'DELETE') init.body = JSON.stringify(body);
  var response = await fetch(url, init);
  var raw = await response.text();
  var data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (error) { data = null; }
  if (!response.ok) {
    var message = data && data.error ? data.error : 'HTTP ' + response.status;
    if (data && data.message) message += ': ' + data.message;
    var problem = new Error(message);
    problem.status = response.status;
    throw problem;
  }
  return data;
}

function textOf(item) {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (typeof item.message === 'string') return item.message;
  return JSON.stringify(item);
}

function bubble(item) {
  var role = item && typeof item === 'object' && item.role ? String(item.role) : 'assistant';
  var node = document.createElement('div');
  node.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  var who = document.createElement('div');
  who.className = 'who';
  who.textContent = role;
  var text = document.createElement('div');
  text.textContent = textOf(item);
  node.appendChild(who);
  node.appendChild(text);
  return node;
}

function render(items) {
  msgs.innerHTML = '';
  if (!items || items.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing here yet — send the first message.';
    msgs.appendChild(empty);
    return;
  }
  items.forEach(function (item) { msgs.appendChild(bubble(item)); });
  msgs.scrollTop = msgs.scrollHeight;
}

function append(item) {
  var empty = msgs.querySelector('.empty');
  if (empty) empty.remove();
  msgs.appendChild(bubble(item));
  msgs.scrollTop = msgs.scrollHeight;
}

async function ensureConversation() {
  var id = localStorage.getItem(CONV_KEY);
  if (id) return id;
  if (!OPS.start) throw new Error('spec has no start operation: cannot create a conversation');
  var data = await request(OPS.start, {});
  id = typeof data === 'string' ? data : (data && (data.id || data.result));
  if (!id) throw new Error('start did not return a conversation id');
  localStorage.setItem(CONV_KEY, id);
  return id;
}

function conversationValues(op, id) {
  var values = {};
  op.params.forEach(function (p) { if (p.where === 'path') values[p.name] = id; });
  return values;
}

async function loadHistory() {
  setStatus('loading…');
  try {
    var id = await ensureConversation();
    convEl.textContent = 'conversation ' + String(id).slice(0, 8);
    var items = await request(OPS.history, conversationValues(OPS.history, id));
    render(Array.isArray(items) ? items : (items && items.result) || []);
    setStatus('');
  } catch (error) {
    setStatus('');
    convEl.textContent = '';
    render([]);
    msgs.innerHTML = '';
    var problem = document.createElement('div');
    problem.className = 'bad';
    problem.textContent = String(error && error.message ? error.message : error);
    msgs.appendChild(problem);
  }
}

async function send(text) {
  var id = await ensureConversation();
  append({ role: 'user', text: text });
  var values = conversationValues(OPS.send, id);
  values[OPS.send.textParam] = text;
  var reply = await request(OPS.send, values);
  append(reply && reply.result !== undefined ? reply.result : reply);
}

form.addEventListener('submit', async function (event) {
  event.preventDefault();
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendButton.disabled = true;
  setStatus('model is thinking…');
  try {
    await send(text);
    setStatus('');
  } catch (error) {
    setStatus('');
    var problem = document.createElement('div');
    problem.className = 'bad';
    problem.textContent = String(error && error.message ? error.message : error);
    msgs.appendChild(problem);
    msgs.scrollTop = msgs.scrollHeight;
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

input.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

resetButton.addEventListener('click', async function () {
  localStorage.removeItem(CONV_KEY);
  convEl.textContent = '';
  render([]);
  await loadHistory();
});

if (HAS_AUTH) {
  var auth = document.getElementById('auth');
  auth.hidden = false;
  var tokenInput = document.getElementById('token');
  tokenInput.value = token();
  document.getElementById('save-token').addEventListener('click', function () {
    localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
    loadHistory();
  });
}

loadHistory();
</script>
</body>
</html>
`;
