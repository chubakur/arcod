// The presentation layout: one page, two audiences. The host opens it on the
// big screen, guests open the same page from a QR code. Slides and widgets are
// declared in the spec, so the page never guesses what is on a slide; the
// service only stores the position and the answers.
export const PRESENTATION_PAGE = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #ffffff; --ink: #111827; --muted: #6b7280;
    --line: #e5e7eb; --accent: #4f46e5; --accent-ink: #ffffff; --ok: #059669;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0f17; --card: #151b26; --ink: #f3f4f6; --muted: #9aa4b2;
      --line: #26303f; --accent: #6366f1; --accent-ink: #ffffff; --ok: #34d399; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
  h1 { font-size: clamp(28px, 5vw, 44px); margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: clamp(24px, 4vw, 38px); margin: 0 0 10px; letter-spacing: -0.02em; }
  p { margin: 0 0 12px; }
  button { font: inherit; cursor: pointer; border-radius: 12px; border: 1px solid var(--line);
    background: var(--card); color: var(--ink); padding: 12px 16px; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: default; }
  button.chosen { opacity: 1; border-color: var(--accent); color: var(--accent); font-weight: 600; }
  input, textarea { font: inherit; width: 100%; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--card); color: var(--ink); }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .stage-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; }
  .code { font: 700 30px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; }
  .qr { background: #fff; padding: 10px; border-radius: 14px; line-height: 0; }
  .qr canvas { width: 132px; height: 132px; display: block; }
  .slide { margin: 22px 0; }
  .slide-body { font-size: clamp(18px, 2.6vw, 24px); color: var(--muted); }
  .bar { height: 46px; border-radius: 10px; background: var(--line); position: relative; overflow: hidden; }
  .bar > i { position: absolute; inset: 0 auto 0 0; background: var(--accent); width: 0; transition: width .35s; }
  .bar > span { position: relative; display: flex; justify-content: space-between; padding: 12px 14px;
    font-weight: 600; color: var(--ink); }
  .option { display: grid; gap: 10px; }
  .stars { display: flex; gap: 8px; flex-wrap: wrap; }
  .stars button { font-size: 22px; min-width: 52px; }
  .big { font-size: clamp(40px, 9vw, 72px); font-weight: 700; letter-spacing: -0.03em; }
  .comments { display: grid; gap: 8px; max-height: 260px; overflow: auto; }
  .comment { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; }
  .comment b { display: block; font-size: 13px; color: var(--muted); }
  .foot { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-top: 18px; }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 13px; color: var(--muted); }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
    background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 10px; opacity: 0;
    transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: .95; }
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<div class="toast" id="toast"></div>
<script>
__QR__
</script>
<script>
var DECK = __DECK__;
var OPS = __OPS__;
var TITLE = DECK.title;
var HAS_AUTH = __HAS_AUTH__;
var HOST_KEY = 'arcod.presentation.host';
var GUEST_PREFIX = 'arcod.presentation.guest.';
var app = document.getElementById('app');
var toastEl = document.getElementById('toast');
var timer = null;

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
}
function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
function keep(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function drop(key) { localStorage.removeItem(key); }
function headers() {
  var out = { 'content-type': 'application/json' };
  if (HAS_AUTH) { var t = localStorage.getItem('arcod.token'); if (t) out.authorization = 'Bearer ' + t; }
  return out;
}
function build(op, values) {
  var url = op.path, query = new URLSearchParams(), body = {};
  op.params.forEach(function (p) {
    var v = values[p.name];
    if (p.where === 'path') url = url.split(':' + p.name).join(encodeURIComponent(String(v == null ? '' : v)));
    else if (p.where === 'query') { if (v != null && v !== '') query.append(p.name, String(v)); }
    else if (v !== undefined) body[p.name] = v;
  });
  if (query.toString()) url += '?' + query.toString();
  var init = { method: op.method, headers: headers() };
  if (op.method !== 'GET' && op.method !== 'DELETE') init.body = JSON.stringify(body);
  return { url: url, init: init };
}
async function call(op, values) {
  if (!op) throw new Error('операция не объявлена в ui');
  var req = build(op, values);
  var res = await fetch(req.url, req.init);
  var raw = await res.text();
  var data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }
  if (!res.ok) {
    var error = new Error((data && data.message) || ('HTTP ' + res.status));
    error.code = data && data.error;
    throw error;
  }
  return data;
}
function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function slideAt(index) { return DECK.slides[index] || null; }
function joinLink() {
  return location.origin + location.pathname + '#/join?code=' + encodeURIComponent(currentCode || '');
}
function drawQr(canvas, text) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  var count = qr.getModuleCount();
  var quiet = 4;
  var size = 256;
  var cell = Math.floor(size / (count + quiet * 2));
  size = cell * (count + quiet * 2);
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#111827';
  for (var row = 0; row < count; row += 1) {
    for (var col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
    }
  }
}
function qrBox(text) {
  var box = el('div', 'qr');
  var canvas = document.createElement('canvas');
  box.appendChild(canvas);
  drawQr(canvas, text);
  return box;
}

var currentCode = '';
var current = { index: -1 };

function landing(note) {
  stopPolling();
  app.replaceChildren();
  var head = el('div', 'card');
  head.appendChild(el('h1', null, TITLE));
  head.appendChild(el('p', 'muted', 'Ведущий открывает сеанс на большом экране, участники подключаются по коду или QR.'));
  if (note) head.appendChild(el('p', 'muted', note));
  app.appendChild(head);

  var grid = el('div', 'grid');
  grid.style.marginTop = '16px';

  var host = el('div', 'card');
  host.appendChild(el('h2', null, 'Я ведущий'));
  host.appendChild(el('p', 'muted', 'Создайте сеанс: получите код, QR и слайды.'));
  var create = el('button', 'primary', 'Создать сеанс');
  create.onclick = async function () {
    create.disabled = true;
    try {
      var session = await call(OPS.start, {});
      keep(HOST_KEY, session);
      currentCode = session.code;
      route();
    } catch (error) {
      create.disabled = false;
      toast('Не удалось создать сеанс: ' + (error.code || error.message));
    }
  };
  host.appendChild(create);
  grid.appendChild(host);

  var guest = el('div', 'card');
  guest.appendChild(el('h2', null, 'Я участник'));
  var codeInput = el('input');
  codeInput.placeholder = 'Код сеанса';
  codeInput.autocapitalize = 'characters';
  codeInput.style.marginBottom = '10px';
  var nameInput = el('input');
  nameInput.placeholder = 'Ваше имя';
  nameInput.style.marginBottom = '10px';
  var join = el('button', 'primary', 'Войти');
  join.onclick = function () { enterAsGuest(codeInput.value.trim().toUpperCase(), nameInput.value.trim()); };
  guest.appendChild(codeInput);
  guest.appendChild(nameInput);
  guest.appendChild(join);
  grid.appendChild(guest);
  app.appendChild(grid);
}

async function enterAsGuest(code, name) {
  if (!code || !name) { toast('Нужны код сеанса и имя'); return; }
  try {
    var member = await call(OPS.join, { code: code, name: name });
    keep(GUEST_PREFIX + code, { id: member.id, token: member.token, name: name, code: code });
    currentCode = code;
    location.hash = '#/join?code=' + encodeURIComponent(code);
    route();
  } catch (error) {
    toast(error.code === 'NotFound' ? 'Сеанс не найден' : 'Не удалось войти: ' + (error.code || error.message));
  }
}

function guestSession() {
  var code = new URLSearchParams((location.hash.split('?')[1] || '')).get('code');
  if (code) {
    currentCode = code.toUpperCase();
    var saved = read(GUEST_PREFIX + currentCode);
    if (saved) return saved;
    return { code: currentCode, pending: true };
  }
  return null;
}

function startPolling(fn) {
  stopPolling();
  timer = setInterval(fn, 1500);
}
function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

async function hostView(session) {
  stopPolling();
  currentCode = session.code;
  app.replaceChildren();
  var head = el('div', 'card stage-head');
  var left = el('div');
  left.appendChild(el('div', 'pill', 'сеанс ' + session.code));
  left.appendChild(el('h1', null, TITLE));
  left.appendChild(el('p', 'muted', 'Участники: ' + (current.joined || 0)));
  head.appendChild(left);
  var right = el('div');
  right.style.textAlign = 'center';
  right.appendChild(qrBox(joinLink()));
  right.appendChild(el('div', 'code', session.code));
  head.appendChild(right);
  app.appendChild(head);

  var stage = el('div', 'card slide');
  app.appendChild(stage);

  var foot = el('div', 'foot');
  var prev = el('button', null, '← Назад');
  var next = el('button', 'primary', 'Далее →');
  var progress = el('span', 'muted', '');
  foot.appendChild(prev);
  foot.appendChild(progress);
  foot.appendChild(next);
  app.appendChild(foot);
  var busy = false;

  function move(delta) {
    if (busy) return;
    busy = true;
    call(OPS.advance, { id: session.id, token: session.token, delta: delta, total: DECK.slides.length })
      .then(function (state) { current = state; renderHost(stage, state, session); })
      .catch(function (error) { toast('Не удалось переключить слайд: ' + (error.code || error.message)); })
      .finally(function () { busy = false; });
  }
  prev.onclick = function () { move(-1); };
  next.onclick = function () { move(1); };

  async function tick() {
    try {
      var state = await call(OPS.state, { id: session.id, token: session.token });
      current = state;
      renderHost(stage, state, session);
      if (left.lastChild && left.lastChild.className === 'muted') left.lastChild.textContent = 'Участники: ' + (state.joined || 0);
      progress.textContent = (state.index + 1) + ' / ' + DECK.slides.length;
    } catch (error) {
      if (error.code === 'NotFound') { drop(HOST_KEY); stopPolling(); landing('Сеанс больше не существует.'); }
    }
  }
  await tick();
  startPolling(tick);
}

function renderHost(stage, state, session) {
  stage.replaceChildren();
  var slide = slideAt(state.index);
  if (!slide) {
    stage.appendChild(el('h2', null, 'Слайдов больше нет'));
    stage.appendChild(el('p', 'muted', 'Вернитесь назад или создайте новый сеанс.'));
    return;
  }
  stage.appendChild(el('div', 'pill', 'слайд ' + (state.index + 1) + ' из ' + DECK.slides.length));
  stage.appendChild(el('h2', null, slide.title));
  if (slide.body) stage.appendChild(el('p', 'slide-body', slide.body));
  var widget = slide.widget;
  if (!widget) return;
  if (widget.kind === 'qr') {
    var box = el('div', 'row');
    box.appendChild(qrBox(joinLink()));
    var info = el('div');
    info.appendChild(el('div', 'muted', 'Откройте ссылку или отсканируйте код'));
    var link = el('div', 'code', joinLink());
    link.style.fontSize = '16px';
    link.style.wordBreak = 'break-all';
    info.appendChild(link);
    box.appendChild(info);
    stage.appendChild(box);
    return;
  }
  if (widget.kind === 'poll') {
    var counts = state.counts || [];
    var total = counts.reduce(function (sum, value) { return sum + (value || 0); }, 0);
    var list = el('div', 'option');
    widget.options.forEach(function (label, index) {
      var count = counts[index] || 0;
      var share = total > 0 ? Math.round((count / total) * 100) : 0;
      var bar = el('div', 'bar');
      var fill = el('i');
      fill.style.width = share + '%';
      bar.appendChild(fill);
      var text = el('span');
      text.appendChild(el('span', null, label));
      text.appendChild(el('span', null, count + ' · ' + share + '%'));
      bar.appendChild(text);
      list.appendChild(bar);
    });
    stage.appendChild(list);
    stage.appendChild(el('p', 'muted', 'Голосов: ' + total));
    return;
  }
  if (widget.kind === 'rating') {
    var average = state.average;
    var rated = state.rated || 0;
    var row = el('div', 'row');
    row.appendChild(el('div', 'big', average == null ? '—' : Number(average).toFixed(1)));
    var meta = el('div');
    meta.appendChild(el('div', 'muted', 'из ' + widget.max));
    meta.appendChild(el('div', 'muted', 'оценок: ' + rated));
    row.appendChild(meta);
    stage.appendChild(row);
    return;
  }
  if (widget.kind === 'comments') {
    var comments = state.comments || [];
    if (comments.length === 0) { stage.appendChild(el('p', 'muted', 'Комментариев пока нет.')); return; }
    var feed = el('div', 'comments');
    comments.slice(-12).reverse().forEach(function (item) {
      var row = el('div', 'comment');
      row.appendChild(el('b', null, item.name || 'аноним'));
      row.appendChild(el('span', null, item.text || ''));
      feed.appendChild(row);
    });
    stage.appendChild(feed);
  }
}

async function guestView(member) {
  stopPolling();
  currentCode = member.code;
  app.replaceChildren();
  if (member.pending) {
    app.appendChild(el('h1', null, TITLE));
    app.appendChild(el('p', 'muted', 'Сеанс ' + member.code + '. Представьтесь, чтобы войти.'));
    var nameInput = el('input');
    nameInput.placeholder = 'Ваше имя';
    nameInput.style.maxWidth = '320px';
    nameInput.style.marginBottom = '10px';
    var button = el('button', 'primary', 'Войти');
    button.onclick = function () { enterAsGuest(member.code, nameInput.value.trim()); };
    app.appendChild(nameInput);
    app.appendChild(button);
    nameInput.focus();
    return;
  }

  var head = el('div', 'row');
  head.appendChild(el('span', 'pill', member.name));
  head.appendChild(el('span', 'pill', 'в сеансе'));
  app.appendChild(head);

  var stage = el('div', 'card slide');
  app.appendChild(stage);
  var widgetBox = el('div');
  var voted = {};

  function renderGuest(state, slider) {
    stage.replaceChildren();
    var slide = slideAt(state.index);
    if (!slide) { stage.appendChild(el('p', 'muted', 'Ведущий ещё не начал.')); return; }
    stage.appendChild(el('div', 'pill', 'слайд ' + (state.index + 1) + ' из ' + DECK.slides.length));
    stage.appendChild(el('h2', null, slide.title));
    if (slide.body) stage.appendChild(el('p', 'slide-body', slide.body));
    var widget = slide.widget;
    if (!widget) return;
    if (widget.kind === 'qr') {
      stage.appendChild(el('p', 'muted', 'Этот слайд показывает QR для подключения.'));
      return;
    }
    if (widget.kind === 'poll') {
      var list = el('div', 'option');
      var answered = voted[state.index];
      widget.options.forEach(function (label, index) {
        var button = el('button', answered === index ? 'chosen' : '', label);
        button.disabled = answered != null;
        button.onclick = function () {
          call(OPS.vote, { id: member.id, token: member.token, choice: index }).then(function () {
            voted[state.index] = index;
            toast('Голос учтён');
            renderGuest(state, slider);
          }).catch(function (error) { toast('Не удалось проголосовать: ' + (error.code || error.message)); });
        };
        list.appendChild(button);
      });
      stage.appendChild(list);
      return;
    }
    if (widget.kind === 'rating') {
      var stars = el('div', 'stars');
      var rated = voted['r' + state.index];
      for (var value = 1; value <= widget.max; value += 1) {
        (function (value) {
          var button = el('button', rated === value ? 'chosen' : '', String(value));
          button.disabled = rated != null;
          button.onclick = function () {
            call(OPS.rate, { id: member.id, token: member.token, value: value }).then(function () {
              voted['r' + state.index] = value;
              toast('Оценка принята');
              renderGuest(state, slider);
            }).catch(function (error) { toast('Не удалось оценить: ' + (error.code || error.message)); });
          };
          stars.appendChild(button);
        })(value);
      }
      stage.appendChild(stars);
      return;
    }
    if (widget.kind === 'comments') {
      var form = el('div');
      var input = el('textarea');
      input.rows = 3;
      input.placeholder = 'Ваш комментарий';
      input.style.marginBottom = '10px';
      var send = el('button', 'primary', 'Отправить');
      send.onclick = function () {
        var text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        call(OPS.comment, { id: member.id, token: member.token, text: text }).then(function () {
          input.value = '';
          send.disabled = false;
          toast('Комментарий отправлен');
        }).catch(function (error) { send.disabled = false; toast('Не удалось отправить: ' + (error.code || error.message)); });
      };
      form.appendChild(input);
      form.appendChild(send);
      stage.appendChild(form);
    }
  }

  async function tick() {
    try {
      var state = await call(OPS.state, { id: member.id, token: member.token });
      if (current.index !== state.index) {
        current = state;
        renderGuest(state, member);
      } else {
        current = state;
      }
    } catch (error) {
      if (error.code === 'NotFound') {
        drop(GUEST_PREFIX + member.code);
        stopPolling();
        landing('Сеанс завершён или не найден.');
      }
    }
  }
  var first = await call(OPS.state, { id: member.id, token: member.token }).catch(function (error) {
    if (error.code === 'NotFound') { drop(GUEST_PREFIX + member.code); stopPolling(); landing('Сеанс завершён или не найден.'); }
    return null;
  });
  if (first) { current = first; renderGuest(first, member); }
  startPolling(tick);
}

function route() {
  var guest = guestSession();
  if (guest) { guestView(guest); return; }
  var host = read(HOST_KEY);
  if (host) { hostView(host); return; }
  landing();
}

window.addEventListener('hashchange', function () {
  current = { index: -1 };
  route();
});
route();
</script>
</body>
</html>`;
