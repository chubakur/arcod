import type { ModuleNode, OpNode } from './ast.ts';
import { isGuarded, paramLimits, pickService, routeOf } from './service.ts';
import { payloadOf } from '../plan-body.ts';

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d12;
    --panel: #141821;
    --line: #232a38;
    --text: #e7ebf3;
    --muted: #8b95a7;
    --accent: #6ea8fe;
    --accent-2: #8b5cf6;
    --ok: #34d399;
    --err: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: radial-gradient(1200px 600px at 20% -10%, #1b2233 0%, var(--bg) 55%);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: min(680px, 100%);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 28px;
    box-shadow: 0 30px 80px rgba(0,0,0,.45);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted);
    margin-bottom: 18px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -.02em; }
  p.lead { margin: 0 0 22px; color: var(--muted); }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .field span { font-size: 13px; color: var(--muted); }
  .field input {
    width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--line); background: #0f131b; color: var(--text); font: inherit;
  }
  .field input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(110,168,254,.15); }
  textarea {
    width: 100%; min-height: 150px; resize: vertical;
    padding: 14px 16px; border-radius: 12px;
    border: 1px solid var(--line); background: #0e121a; color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
  }
  textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(110,168,254,.15); }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  button {
    appearance: none; border: 0; cursor: pointer;
    padding: 11px 18px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #06101f; font-weight: 650; font-size: 14px;
  }
  button.secondary { background: #1b2230; color: var(--text); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: progress; }
  .muted { color: var(--muted); font-size: 13px; }
  .result {
    margin-top: 18px; padding: 14px 16px; border-radius: 12px;
    border: 1px solid var(--line); background: #0e121a;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
  }
  .result a { color: var(--accent); }
  .message {
    white-space: pre-wrap; word-break: break-word;
    margin: 0; padding: 16px; border-radius: 12px;
    background: #0e121a; border: 1px solid var(--line);
    font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .status { margin-top: 14px; font-size: 14px; }
  .status.ok { color: var(--ok); }
  .status.err { color: var(--err); }
  .hidden { display: none !important; }
  .meta { margin-top: 18px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="dot"></span><span>__BRAND__</span></div>

  <section id="create-view">
    <h1>__TITLE__</h1>
    <p class="lead">__LEAD__</p>
    <div id="fields">
    __FIELDS__
    </div>
    <div id="pwd-create-slot"></div>
    <div class="row">
      <button id="submit">Создать ссылку</button>
      <span class="muted" id="hint">__HINT__</span>
    </div>
    <div class="result hidden" id="result">
      <div class="muted">Ссылка (открой её у получателя):</div>
      <div><a id="link" href="#"></a></div>
      <div class="row">
        <button class="secondary" id="copy">Скопировать</button>
        <button class="secondary" id="again">Создать ещё</button>
      </div>
    </div>
    <div class="status" id="create-status"></div>
  </section>

  <section id="read-view" class="hidden">
    <h1 id="read-title">Чтение</h1>
    <p class="lead" id="read-lead">Загружаем сообщение...</p>
    <pre class="message hidden" id="message"></pre>
    <div class="status" id="read-status"></div>
    <div class="meta"><a href="/">Создать своё сообщение</a></div>
  </section>

  <div class="meta">сгенерировано arcod из __MODULE__</div>
</main>

<script>
const API_CREATE = '__CREATE_PATH__';
const LINK_PREFIX = '__LINK_PREFIX__';
const API_READ = '__READ_PATH__';
const MAX_BYTES = __MAX_BYTES__;
const FIELDS = __FIELDS_JSON__;

const byId = (id) => document.getElementById(id);
const createView = byId('create-view');
const readView = byId('read-view');

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function create() {
  const payload = {};
  for (const field of FIELDS) payload[field.name] = byId('f-' + field.name).value;
  for (const field of FIELDS) {
    const bytes = new TextEncoder().encode(payload[field.name]).length;
    if (bytes < field.min) return setStatus(byId('create-status'), 'Заполните поле: ' + field.label, 'err');
    if (bytes > field.max) return setStatus(byId('create-status'), 'Поле ' + field.label + ' больше ' + field.max + ' байт', 'err');
  }

  const button = byId('submit');
  button.disabled = true;
  setStatus(byId('create-status'), 'Создаём...', '');
  try {
    const response = await fetch(API_CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'не удалось создать');

    const link = location.origin + LINK_PREFIX + encodeURIComponent(data.id);
    const anchor = byId('link');
    anchor.textContent = link;
    anchor.href = link;
    byId('result').classList.remove('hidden');
    for (const field of FIELDS) byId('f-' + field.name).value = '';
    setStatus(byId('create-status'), 'Готово. Ссылка живёт ' + data.expiresIn + ' сек.', 'ok');
  } catch (error) {
    setStatus(byId('create-status'), String(error.message || error), 'err');
  } finally {
    button.disabled = false;
  }
}

async function read(id) {
  createView.classList.add('hidden');
  readView.classList.remove('hidden');
  setStatus(byId('read-status'), 'Загружаем...', '');
  try {
    const response = await fetch(API_READ.replace(':id', encodeURIComponent(id)));
    if (response.status === 200) {
      const raw = await response.text();
      let text = raw;
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
      byId('read-lead').textContent = 'Сообщение будет удалено после этого просмотра.';
      const message = byId('message');
      message.textContent = text;
      message.classList.remove('hidden');
      setStatus(byId('read-status'), 'Прочитано. Повторно открыть не получится.', 'ok');
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      byId('read-title').textContent = 'Сообщения нет';
      byId('read-lead').textContent = 'Возможно, ссылка неверна или срок хранения истёк.';
    } else if (response.status === 410) {
      byId('read-title').textContent = 'Уже прочитано';
      byId('read-lead').textContent = 'Это одноразовое сообщение. Кто-то открыл его раньше.';
    } else {
      byId('read-title').textContent = 'Ошибка';
      byId('read-lead').textContent = data.message || 'Не удалось загрузить сообщение.';
    }
  } catch (error) {
    byId('read-lead').textContent = 'Сервис недоступен.';
    setStatus(byId('read-status'), String(error.message || error), 'err');
  }
}

byId('submit').addEventListener('click', create);
byId('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(byId('link').textContent);
  setStatus(byId('create-status'), 'Ссылка скопирована', 'ok');
});
byId('again').addEventListener('click', () => {
  byId('result').classList.add('hidden');
  setStatus(byId('create-status'), '', '');
  const firstField = FIELDS[0] && byId('f-' + FIELDS[0].name);
  if (firstField) firstField.focus();
});

const id = new URLSearchParams(location.search).get('id');
if (id) read(id);
</script>
</body>
</html>
`;

export interface WebOptions {
  maxBytes: number;
  title?: string;
}

export function emitWeb(mod: ModuleNode, options: WebOptions): string {
  const ui = mod.uis[0];
  if (!ui) throw new Error('no ui block declared; add ui <Name> { ... } to generate a frontend');
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to emit web for');

  const create = svc.contract.find((op) => op.name === 'create');
  const read = svc.contract.find((op) => op.name === 'read');
  if (!create || !read) throw new Error('web emitter needs create and read');

  const createPath = pathOf(create);
  const readPath = pathOf(read);

  const linkPrefix = ui.route === '/' ? '/?id=' : ui.route.replace(/\/$/, '') + '/?id=';

  const payload = payloadOf(mod, create);
  const fields = payload.map((param) => {
    const limits = paramLimits(mod, param.type);
    const label = fieldLabel(param.name);
    const tag = limits.multiline ? 'textarea' : 'input';
    const open = limits.multiline
      ? '<textarea id="f-' + param.name + '" placeholder="' + label + '"></textarea>'
      : '<input id="f-' + param.name + '" type="text" autocomplete="off" placeholder="' + label + '">';
    return '      <label class="field"><span>' + label + '</span>' + open + '</label>';
  });
  const fieldMeta = payload.map((param) => {
    const limits = paramLimits(mod, param.type);
    return { name: param.name, label: fieldLabel(param.name), min: limits.min, max: limits.max };
  });
  const hint = payload.length === 1
    ? 'максимум ' + Math.round(paramLimits(mod, payload[0].type).max / 1024) + ' КБ'
    : payload.map((param) => param.name).join(', ');

  let html = PAGE
    .replaceAll('__FIELDS__', fields.join('\n'))
    .replaceAll('__FIELDS_JSON__', JSON.stringify(fieldMeta))
    .replaceAll('__HINT__', hint)
    .replaceAll('__LEAD__', 'Заполните поля — сервис вернёт ссылку на сохранённое значение.')
    .replaceAll('__TITLE__', ui.title ?? svc.name)
    .replaceAll('__BRAND__', mod.name + ' · ' + ui.name)
    .replaceAll('__LINK_PREFIX__', linkPrefix)
    .replaceAll('__MODULE__', mod.name + '@' + mod.version)
    .replaceAll('__CREATE_PATH__', createPath)
    .replaceAll('__READ_PATH__', readPath)
    .replaceAll('__MAX_BYTES__', String(options.maxBytes));

  if (isGuarded(svc)) html = withPasswordUi(html);
  return html;
}

// Password UI is layered on top of the base page: the page itself stays one
// template, and only the guarded service gets the extra field and branch.
function withPasswordUi(html: string): string {
  return html
    .replace('</style>', `  .pwd { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .pwd label { font-size: 13px; }
  .pwd input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: #0f131b; color: var(--text); font: inherit; }
  .pwd .row { display: flex; gap: 8px; align-items: center; }
  .pwd .row input { flex: 1; }
</style>`)
    .replace(
      '<div id="pwd-create-slot"></div>',
      '<div class="pwd">\n' +
        '    <div class="pwd">\n' +
        '      <label class="muted" for="pwd-create">Пароль — необязательно</label>\n' +
        '      <input id="pwd-create" type="password" autocomplete="new-password" placeholder="пусто — откроет любой, у кого есть ссылка">\n' +
        '    </div>',
    )
    .replace(
      '<p class="lead" id="read-lead">Загружаем сообщение...</p>',
      '<p class="lead" id="read-lead">Загружаем сообщение...</p>\n' +
        '    <div class="pwd hidden" id="pwd-read-wrap">\n' +
        '      <label class="muted" for="pwd-read">Сообщение защищено паролем</label>\n' +
        '      <div class="row">\n' +
        '        <input id="pwd-read" type="password" autocomplete="off" placeholder="введите пароль">\n' +
        '        <button id="pwd-open">Открыть</button>\n' +
        '      </div>\n' +
        '    </div>',
    )
    .replace('JSON.stringify(payload)', "JSON.stringify(Object.assign(payload, { password: byId('pwd-create').value }))")
    .replace(
      "fetch(API_READ.replace(':id', encodeURIComponent(id)))",
      "fetch(API_READ.replace(':id', encodeURIComponent(id)) + (byId('pwd-read').value ? '?password=' + encodeURIComponent(byId('pwd-read').value) : ''))",
    )
    .replace(
      `    } else {
      byId('read-title').textContent = 'Ошибка';`,
      `    } else if (response.status === 403) {
      byId('read-title').textContent = 'Нужен пароль';
      byId('read-lead').textContent = 'Сообщение не удалено: введите правильный пароль.';
      byId('pwd-read-wrap').classList.remove('hidden');
      byId('pwd-read').focus();
      setStatus(byId('read-status'), 'Неверный пароль', 'err');
    } else {
      byId('read-title').textContent = 'Ошибка';`,
    )
    .replace(
      "byId('submit').addEventListener('click', create);",
      "byId('submit').addEventListener('click', create);\nbyId('pwd-open').addEventListener('click', () => read(id));",
    );
}

const FIELD_LABELS: Record<string, string> = {
  body: 'Текст',
  message: 'Текст',
  text: 'Текст',
  content: 'Содержимое',
  author: 'Имя',
  name: 'Имя',
  title: 'Заголовок',
  email: 'Email',
};

function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

function pathOf(op: OpNode): string {
  const route = routeOf(op);
  if (!route) throw new Error('op ' + op.name + ' has no route');
  return route.split(' ')[1];
}
