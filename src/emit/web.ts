import type { ModuleNode, OpNode, Param, ServiceNode, TypeExpr, UiNode } from './ast.ts';
import { isGuarded, pickService } from './service.ts';
import { CHAT_PAGE } from './chat-page.ts';
import { PRESENTATION_PAGE } from './presentation-page.ts';
import { hasStream } from './service.ts';
import { QR_SOURCE } from './qr-code.ts';

export interface WebOptions {
  maxBytes: number;
  title?: string;
}

// The page is built from the contract, not from a particular service: every
// public operation becomes a form, every parameter becomes a field, and every
// response is rendered by shape (object, list, error, scalar).
interface UiParam {
  name: string;
  kind: 'text' | 'textarea' | 'number' | 'bool' | 'json';
  where: 'path' | 'query' | 'body';
  optional: boolean;
  max: number | null;
}

interface UiOp {
  name: string;
  method: string;
  path: string;
  params: UiParam[];
  returns: string;
}

const PAGE = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root { color-scheme: light dark; --line: #d8dbe0; --muted: #6b7280; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  .auth { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 24px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
  .auth[hidden] { display: none; }
  .auth input { flex: 1; }
  .op { border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .op h2 { font-size: 16px; margin: 0 0 2px; display: flex; gap: 10px; align-items: baseline; }
  .route { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
  form { display: grid; gap: 10px; margin-top: 12px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  input, textarea, select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  textarea { min-height: 76px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; width: fit-content; }
  button[disabled] { opacity: .6; cursor: progress; }
  .result { margin-top: 12px; }
  .result pre { margin: 0; padding: 12px; border-radius: 8px; background: rgba(127,127,127,.09); overflow: auto; }
  .status { font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted); margin-bottom: 6px; }
  .bad { color: #b91c1c; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--muted); font-size: 13px; }
  dd { margin: 0; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
  <h1>__TITLE__</h1>
  <p class="lead">__LEAD__</p>
  <section class="auth" id="auth" hidden>
    <label style="flex:1">Токен доступа
      <input id="token" type="password" autocomplete="off" placeholder="Bearer-токен">
    </label>
    <button type="button" id="save-token" style="align-self:end">Сохранить</button>
  </section>
  <div id="ops"></div>
</main>
<script>
var OPS = __OPS__;
var HAS_AUTH = __HAS_AUTH__;
var TOKEN_KEY = 'arcod.token';

function byId(id) { return document.getElementById(id); }

function saveToken() {
  var value = byId('token').value.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  byId('token').value = '';
  byId('token').placeholder = value ? 'токен сохранён' : 'Bearer-токен';
}

function showError(out, text) {
  out.hidden = false;
  out.innerHTML = '';
  var pre = document.createElement('pre');
  pre.className = 'bad';
  pre.textContent = text;
  out.appendChild(pre);
}

function renderValue(value) {
  if (value === null) return document.createTextNode('null');
  if (typeof value === 'object') {
    var pre = document.createElement('pre');
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }
  return document.createTextNode(String(value));
}

function renderResult(out, status, data, raw) {
  out.hidden = false;
  out.innerHTML = '';
  var badge = document.createElement('div');
  badge.className = 'status' + (status >= 400 ? ' bad' : '');
  badge.textContent = 'HTTP ' + status;
  out.appendChild(badge);

  if (data === null) {
    var pre = document.createElement('pre');
    pre.textContent = raw || '(пустой ответ)';
    out.appendChild(pre);
    return;
  }

  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
    var err = document.createElement('pre');
    err.className = 'bad';
    err.textContent = String(data.error) + (data.message ? ': ' + data.message : '');
    out.appendChild(err);
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'пусто';
      out.appendChild(empty);
      return;
    }
    if (typeof data[0] === 'object' && data[0] !== null) {
      var keys = [];
      data.forEach(function (item) {
        Object.keys(item || {}).forEach(function (key) { if (keys.indexOf(key) < 0) keys.push(key); });
      });
      var table = document.createElement('table');
      var head = document.createElement('tr');
      keys.forEach(function (key) {
        var th = document.createElement('th');
        th.textContent = key;
        head.appendChild(th);
      });
      table.appendChild(head);
      data.forEach(function (item) {
        var row = document.createElement('tr');
        keys.forEach(function (key) {
          var td = document.createElement('td');
          var value = item ? item[key] : null;
          td.textContent = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
          row.appendChild(td);
        });
        table.appendChild(row);
      });
      out.appendChild(table);
      return;
    }
    var list = document.createElement('pre');
    list.textContent = data.map(function (item) { return typeof item === 'object' ? JSON.stringify(item) : String(item); }).join('\n');
    out.appendChild(list);
    return;
  }

  if (data && typeof data === 'object') {
    var dl = document.createElement('dl');
    Object.keys(data).forEach(function (key) {
      var dt = document.createElement('dt');
      dt.textContent = key;
      var dd = document.createElement('dd');
      dd.appendChild(renderValue(data[key]));
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    out.appendChild(dl);
    return;
  }

  var single = document.createElement('pre');
  single.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  out.appendChild(single);
}

async function run(op, form, out, button) {
  var url = op.path;
  var query = new URLSearchParams();
  var body = {};
  var problem = null;

  op.params.forEach(function (p) {
    var input = form.elements[p.name];
    var raw = p.kind === 'bool' ? input.checked : input.value;
    if (p.kind !== 'bool' && String(raw).trim() === '') {
      if (!p.optional) problem = p.name;
      return;
    }
    var value = raw;
    if (p.kind === 'number') value = Number(raw);
    if (p.kind === 'json') {
      try {
        value = JSON.parse(raw);
      } catch (error) {
        problem = p.name + ': не JSON';
        return;
      }
    }
    if (p.where === 'path') {
      url = url.split(':' + p.name).join(encodeURIComponent(String(raw)));
    } else if (p.where === 'query') {
      query.append(p.name, typeof value === 'object' ? JSON.stringify(value) : String(value));
    } else {
      body[p.name] = value;
    }
  });

  if (problem) {
    showError(out, 'Заполните поле: ' + problem);
    return;
  }
  if (query.toString()) url += '?' + query.toString();

  var headers = { accept: 'application/json' };
  var token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.authorization = 'Bearer ' + token;

  var init = { method: op.method, headers: headers };
  if (op.method !== 'GET' && op.method !== 'DELETE') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  button.disabled = true;
  out.hidden = false;
  out.innerHTML = '<div class="status">запрос…</div>';
  try {
    var response = await fetch(url, init);
    var raw = await response.text();
    var data = null;
    try { data = JSON.parse(raw); } catch (error) { data = null; }
    renderResult(out, response.status, data, raw);
  } catch (error) {
    showError(out, String(error && error.message ? error.message : error));
  } finally {
    button.disabled = false;
  }
}

function fieldControl(p) {
  var input;
  if (p.kind === 'textarea' || p.kind === 'json') {
    input = document.createElement('textarea');
    input.rows = 3;
  } else if (p.kind === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
  } else {
    input = document.createElement('input');
    input.type = p.kind === 'number' ? 'number' : 'text';
    if (p.max && p.kind !== 'number') input.maxLength = p.max;
  }
  input.name = p.name;
  return input;
}

function build() {
  var root = byId('ops');
  OPS.forEach(function (op) {
    var card = document.createElement('section');
    card.className = 'op';

    var title = document.createElement('h2');
    title.textContent = op.name;
    var route = document.createElement('span');
    route.className = 'route';
    route.textContent = op.method + ' ' + op.path;
    title.appendChild(route);
    card.appendChild(title);

    var form = document.createElement('form');
    op.params.forEach(function (p) {
      var label = document.createElement('label');
      label.textContent = p.name + (p.kind === 'json' ? ' (JSON)' : '') + (p.optional ? ' — необязательно' : '');
      label.appendChild(fieldControl(p));
      form.appendChild(label);
    });

    var button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Выполнить';
    form.appendChild(button);

    var out = document.createElement('div');
    out.className = 'result';
    out.hidden = true;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      run(op, form, out, button);
    });

    card.appendChild(form);
    card.appendChild(out);
    root.appendChild(card);
  });
}

if (HAS_AUTH) {
  byId('auth').hidden = false;
  byId('save-token').addEventListener('click', saveToken);
}
build();
</script>
</body>
</html>
`;

function expand(mod: ModuleNode, type: TypeExpr, depth = 0): TypeExpr {
  if (type.kind !== 'named') return type;
  const decl = mod.types.find((item) => item.name === type.name);
  if (!decl || depth > 8) return type;
  return expand(mod, decl.type, depth + 1);
}

function numberValue(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const expr = value as { kind?: string; value?: unknown; unit?: string };
  if (expr.kind === 'literal' && typeof expr.value === 'number') return expr.value;
  if (expr.kind === 'duration' && typeof expr.value === 'number') {
    const unit = (expr.unit ?? '').toLowerCase();
    if (unit === 'kb') return expr.value * 1024;
    if (unit === 'mb') return expr.value * 1024 * 1024;
    if (unit === 'gb') return expr.value * 1024 * 1024 * 1024;
    return expr.value;
  }
  return null;
}

function maxOf(type: TypeExpr): number | null {
  if (type.kind !== 'named') return null;
  const arg = type.args.find((item) => item.name === 'max');
  return arg ? numberValue(arg.value) : null;
}

function uiParam(mod: ModuleNode, param: Param, where: 'path' | 'query' | 'body'): UiParam {
  const resolved = expand(mod, param.type);
  const optional = param.type.kind === 'optional' || resolved.kind === 'optional';
  let kind: UiParam['kind'] = 'text';
  let max: number | null = null;

  if (resolved.kind === 'record') {
    kind = 'json';
  } else if (resolved.kind === 'named') {
    if (resolved.name === 'list' || resolved.name === 'map' || resolved.name === 'json') kind = 'json';
    else if (resolved.name === 'bool') kind = 'bool';
    else if (resolved.name === 'int' || resolved.name === 'float' || resolved.name === 'number') kind = 'number';
    else if (resolved.name === 'bytes') {
      max = maxOf(resolved);
      kind = max !== null && max > 512 ? 'textarea' : 'text';
    }
  }

  return { name: param.name, kind, where, optional, max };
}

function routeOfOp(op: OpNode): { method: string; path: string } {
  const clause = op.clauses.find((item) => item.kind === 'route');
  const value = clause && clause.kind === 'route' ? clause.value : op.name;
  const [method, path] = value.split(/\s+/);
  return { method: (method || 'GET').toUpperCase(), path: path || '/' };
}

// The chat page needs concrete operations, not a guess: the spec names which
// one returns the transcript and which one sends. The only inferred bit is
// which send parameter carries the text (the single non-path parameter).
function chatOps(mod: ModuleNode, svc: ServiceNode, ui: UiNode): Record<string, unknown> {
  const find = (ref: string | null): UiOp | null => {
    if (!ref) return null;
    const [svcName, opName] = ref.split('.');
    if (svcName !== svc.name) return null;
    const op = svc.contract.find((item) => item.name === opName && item.kind === 'op' && item.isPublic);
    return op ? describeOp(mod, op) : null;
  };
  const history = find(ui.history);
  const send = find(ui.send);
  if (!history || !send) throw new Error('layout: chat needs history and send operations');
  const textParam = send.params.find((param) => param.where !== 'path');
  if (!textParam) throw new Error('send operation has no message parameter');

  const start = find(ui.start);
  const compact = (op: UiOp) => ({
    method: op.method,
    path: op.path,
    params: op.params.map((param) => ({ name: param.name, where: param.where })),
  });
  return {
    module: mod.name,
    history: compact(history),
    send: Object.assign(compact(send), { textParam: textParam.name }),
    start: start ? compact(start) : null,
  };
}

function describeOp(mod: ModuleNode, op: OpNode): UiOp {
  const route = routeOfOp(op);
  const segments = route.path.split('/');
  const pathNames = segments.filter((item) => item.startsWith(':')).map((item) => item.slice(1));
  const readsQuery = route.method === 'GET' || route.method === 'DELETE';
  const params = op.params.map((param) => {
    const where = pathNames.includes(param.name) ? 'path' : readsQuery ? 'query' : 'body';
    return uiParam(mod, param, where);
  });
  const returns = op.returns ? op.returns.kind : 'void';
  return { name: op.name, method: route.method, path: route.path, params, returns };
}

export function emitWeb(mod: ModuleNode, options: WebOptions): string {
  const ui = mod.uis[0];
  if (!ui) throw new Error('no ui block declared; add ui <Name> { ... } to generate a frontend');
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to emit web for');

  const wanted = new Set(ui.uses.map((entry) => entry.split('.').pop() ?? entry));
  const ops = svc.contract
    .filter((op) => op.kind === 'op' && op.isPublic)
    .filter((op) => wanted.size === 0 || wanted.has(op.name))
    .map((op) => describeOp(mod, op));

  if (ops.length === 0) throw new Error('ui block names no public operation');

  const hasAuth = svc.uses.some((use) => use.capability === 'identity' || use.capability.endsWith('.identity'));
  const guarded = isGuarded(svc);

  if (ui.layout === 'presentation') {
    const live = presentationOps(mod, svc, ui);
    const deck = {
      title: options.title ?? ui.title ?? mod.name,
      stream: hasStream(svc),
      slides: ui.slides.map((slide) => ({
        title: slide.title,
        body: slide.body,
        widget: slide.widget
          ? { kind: slide.widget.kind, options: slide.widget.options, max: slide.widget.max }
          : null,
      })),
    };
    return PRESENTATION_PAGE
      .replaceAll('__TITLE__', escapeHtml(options.title ?? ui.title ?? mod.name))
      .replaceAll('__DECK__', jsonForScript(deck))
      .replaceAll('__OPS__', jsonForScript(live))
      .replaceAll('__HAS_AUTH__', hasAuth || guarded ? 'true' : 'false')
      // The QR source is third-party generated code: never interpolate it as a
      // replacement pattern, and insert it last so nothing rewrites it.
      .replaceAll('__QR__', () => QR_SOURCE);
  }

  if (ui.layout === 'chat') {
    const chat = chatOps(mod, svc, ui);
    return CHAT_PAGE
      .replaceAll('__TITLE__', escapeHtml(options.title ?? ui.title ?? mod.name))
      .replaceAll('__LEAD__', escapeHtml(mod.name + '@' + mod.version + ' · ' + svc.name + ' · диалог с моделью'))
      .replaceAll('__CHAT_OPS__', JSON.stringify(chat))
      .replaceAll('__HAS_AUTH__', hasAuth || guarded ? 'true' : 'false');
  }

  return PAGE
    .replaceAll('__TITLE__', escapeHtml(options.title ?? ui.title ?? mod.name))
    .replaceAll('__LEAD__', escapeHtml(mod.name + '@' + mod.version + ' · ' + svc.name + ' · операций: ' + ops.length))
    .replaceAll('__OPS__', JSON.stringify(ops))
    .replaceAll('__HAS_AUTH__', hasAuth || guarded ? 'true' : 'false');
}

// A slide title is author-written text, but it still lands inside a <script>:
// '$' and backslashes are fine, a closing tag is not.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c');
}

// The page is told which operation creates a session, which one brings a guest
// in, which one reports the live state and which one moves the deck. A widget
// binding may be absent when the deck has no such widget, but never guessed.
function presentationOps(mod: ModuleNode, svc: ServiceNode, ui: UiNode): Record<string, unknown> {
  const compact = (op: UiOp) => ({
    name: op.name,
    method: op.method,
    path: op.path,
    returns: op.returns,
    params: op.params.map((param) => ({ name: param.name, where: param.where })),
  });
  const find = (ref: string | null): Record<string, unknown> | null => {
    if (!ref) return null;
    const [svcName, opName] = ref.split('.');
    if (svcName !== svc.name) return null;
    const op = svc.contract.find((item) => item.name === opName && item.kind === 'op' && item.isPublic);
    return op ? compact(describeOp(mod, op)) : null;
  };
  const ops: Record<string, unknown> = {
    start: find(ui.start),
    join: find(ui.join),
    state: find(ui.state),
    advance: find(ui.advance),
    vote: find(ui.vote),
    rate: find(ui.rate),
    comment: find(ui.comment),
  };
  for (const key of ['start', 'join', 'state', 'advance']) {
    if (!ops[key]) throw new Error('layout: presentation needs a ' + key + ' operation');
  }
  return ops;
}

function escapeHtml(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}
