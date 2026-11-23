import type { ModuleNode, OpNode, Param, ServiceNode, TypeExpr, UiNode } from '../ast.ts';
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

// The pages are generated, so their static labels are a catalog, not prose
// buried in markup. 'en' is the base; a locale merges over it, and an unknown
// locale still renders (with English) instead of failing the build.
const UI_STRINGS: Record<string, Record<string, string>> = {
  en: {
    token: 'Access token',
    tokenPlaceholder: 'Bearer token',
    saved: 'token saved',
    save: 'Save',
    run: 'Run',
    json: 'JSON',
    optional: 'optional',
    chatTokenPlaceholder: 'Bearer token',
    chatSave: 'Save',
    chatEmpty: 'Nothing here yet — send the first message.',
    chatPlaceholder: 'Message… (Enter — send, Shift+Enter — new line)',
    chatSend: 'Send',
    chatReset: 'New conversation',
    presIntro: 'The host opens a session on the big screen; participants join with a code or QR.',
    presHostTitle: 'I am the host',
    presHostLead: 'Create a session to get a code, a QR and the slides.',
    presCreate: 'Create session',
    presGuestTitle: 'I am a participant',
    presCode: 'Session code',
    presName: 'Your name',
    presJoin: 'Join',
    presBack: '← Back',
    presNext: 'Next →',
    presParticipants: 'Participants',
    langLabel: 'Language',
  },
  ru: {
    token: 'Токен доступа',
    tokenPlaceholder: 'Bearer-токен',
    saved: 'токен сохранён',
    save: 'Сохранить',
    run: 'Выполнить',
    json: 'JSON',
    optional: 'необязательно',
    chatTokenPlaceholder: 'Bearer-токен',
    chatSave: 'Сохранить',
    chatEmpty: 'Здесь пока пусто — отправьте первое сообщение.',
    chatPlaceholder: 'Сообщение… (Enter — отправить, Shift+Enter — новая строка)',
    chatSend: 'Отправить',
    chatReset: 'Новый диалог',
    presIntro: 'Ведущий открывает сессию на большом экране; участники подключаются по коду или QR.',
    presHostTitle: 'Я ведущий',
    presHostLead: 'Создайте сессию, чтобы получить код, QR и слайды.',
    presCreate: 'Создать сессию',
    presGuestTitle: 'Я участник',
    presCode: 'Код сессии',
    presName: 'Ваше имя',
    presJoin: 'Подключиться',
    presBack: '← Назад',
    presNext: 'Далее →',
    presParticipants: 'Участники',
    langLabel: 'Язык',
  },
};

export function pageStrings(locale: string | null): Record<string, string> {
  const base = (locale ?? 'en').split('-')[0].toLowerCase();
  return { ...UI_STRINGS.en, ...(UI_STRINGS[base] ?? {}), lang: locale ?? 'en' };
}
// Shared by every layout: the catalogs are data, the picker is a <select>
// created here, and a change reloads the page with ?lang=<tag>.
const LANG_RUNTIME = String.raw`
// Every declared catalog is embedded once; ?lang=<tag> chooses one on load and
// an unknown tag falls back to the declared default. The page stays static, so
// switching reloads it.
var CATALOGS = __CATALOGS__;
var LOCALES = __LOCALES__;
var BASE_LANG = '__LANG__';

function chosenLang() {
  if (!CATALOGS || !LOCALES) return BASE_LANG;
  var wanted = null;
  try { wanted = new URLSearchParams(location.search).get('lang'); } catch (error) { wanted = null; }
  return wanted && CATALOGS[wanted] ? wanted : BASE_LANG;
}

function applyLang() {
  var chosen = chosenLang();
  if (CATALOGS && CATALOGS[chosen]) T = CATALOGS[chosen];
  document.documentElement.lang = chosen;
  var select = document.getElementById('lang');
  if (!select || !LOCALES) return;
  LOCALES.forEach(function (tag) {
    var option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  });
  // The label follows the chosen catalog; the markup keeps an English
  // fallback for the no-JS case.
  select.setAttribute('aria-label', (typeof T !== 'undefined' && T && T.langLabel) || 'Language');
  select.value = chosen;
  select.hidden = false;
  select.addEventListener('change', function () {
    var next = new URL(location.href);
    next.searchParams.set('lang', select.value);
    location.href = next.toString();
  });
}
applyLang();
`;

const PAGE = String.raw`<!doctype html>
<html lang="__LANG__" data-theme="__THEME__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  /* Design tokens: one palette the whole page reads. A theme is a data-theme
     attribute, never a different stylesheet; 'auto' follows the OS. */
  :root {
    --surface: #ffffff; --ink: #111827; --line: #d8dbe0; --muted: #6b7280;
    --accent: #2563eb; --on-accent: #ffffff; --danger: #b91c1c;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #0b1020; --ink: #e5e7eb; --line: #2b3245; --muted: #9aa3b2;
    --accent: #6ea8fe; --on-accent: #06122b; --danger: #f87171;
  }
  :root[data-theme="auto"] { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root[data-theme="auto"] {
      --surface: #0b1020; --ink: #e5e7eb; --line: #2b3245; --muted: #9aa3b2;
      --accent: #6ea8fe; --on-accent: #06122b; --danger: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  .head h1 { margin: 0 0 4px; }
  .head .lead { margin: 0; }
  .head select { width: auto; padding: 6px 8px; background: var(--surface); }
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
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); cursor: pointer; width: fit-content; }
  button[disabled] { opacity: .6; cursor: progress; }
  .result { margin-top: 12px; }
  .result pre { margin: 0; padding: 12px; border-radius: 8px; background: rgba(127,127,127,.09); overflow: auto; }
  .status { font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted); margin-bottom: 6px; }
  .bad { color: var(--danger); }
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
  <header class="head">
    <div>
      <h1>__TITLE__</h1>
      <p class="lead">__LEAD__</p>
    </div>
    <select id="lang" hidden aria-label="Language"></select>
  </header>
  <section class="auth" id="auth" hidden>
    <label style="flex:1"><span data-i18n="token">Access token</span>
      <input id="token" type="password" autocomplete="off" placeholder="Bearer token" data-i18n-placeholder="tokenPlaceholder">
    </label>
    <button type="button" id="save-token" style="align-self:end" data-i18n="save">Save</button>
  </section>
  <div id="ops"></div>
</main>
<script>
var OPS = __OPS__;
var SSR = __SSR__;
var HAS_AUTH = __HAS_AUTH__;
var T = __STRINGS__;
__LANG_RUNTIME__
var TOKEN_KEY = 'arcod.token';

function byId(id) { return document.getElementById(id); }

function t(key, fallback) { return (T && T[key]) || fallback; }

function saveToken() {
  var value = byId('token').value.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  byId('token').value = '';
  byId('token').placeholder = value ? t('saved', 'token saved') : t('tokenPlaceholder', 'Bearer token');
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
    pre.textContent = raw || '(empty response)';
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
      empty.textContent = 'empty';
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
        problem = p.name + ': not JSON';
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
    showError(out, 'Fill in the field: ' + problem);
    return;
  }
  if (query.toString()) url += '?' + query.toString();

  var headers = { accept: 'application/json' };
  var token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.authorization = 'Bearer ' + token;

  var init = { method: op.method, headers: headers };
  // HEAD is body-less: no payload and no content-type to describe it.
  if (op.method !== 'GET' && op.method !== 'DELETE' && op.method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  button.disabled = true;
  out.hidden = false;
  out.innerHTML = '<div class="status">request…</div>';
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
    // A bytes limit is a character ceiling on the field too, not only a size
    // hint: the API rejects a longer body, and the form should say so first.
    if (p.kind === 'textarea' && p.max) input.maxLength = p.max;
  } else if (p.kind === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
  } else {
    input = document.createElement('input');
    input.type = p.kind === 'number' ? 'number' : 'text';
    if (p.max && p.kind !== 'number') input.maxLength = p.max;
  }
  input.name = p.name;
  // Screen readers get the same contract the API does: a required field is
  // required, and a browser's autofill must not guess at API parameters.
  input.autocomplete = 'off';
  if (!p.optional) input.setAttribute('aria-required', 'true');
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
      label.textContent = p.name + (p.kind === 'json' ? ' (' + t('json', 'JSON') + ')' : '') + (p.optional ? ' — ' + t('optional', 'optional') : '');
      label.appendChild(fieldControl(p));
      form.appendChild(label);
    });

    var button = document.createElement('button');
    button.type = 'submit';
    button.textContent = t('run', 'Run');
    form.appendChild(button);

    var out = document.createElement('div');
    out.className = 'result';
    out.hidden = true;
    // A result arrives after an async call: announce it, do not move focus.
    out.setAttribute('role', 'status');
    out.setAttribute('aria-live', 'polite');

    // An ssr page arrives with its first screen already fetched: render that
    // data instead of issuing a request the server has already answered.
    if (SSR && SSR.op === op.name && SSR.data !== null) {
      out.setAttribute('data-ssr', 'hydrated');
      renderResult(out, 200, SSR.data, null);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      run(op, form, out, button);
    });

    card.appendChild(form);
    card.appendChild(out);
    root.appendChild(card);
  });
}

localize();
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
    else if (resolved.name === 'bytes' || resolved.name === 'string') {
      // Both refinements carry a character limit; only bytes is large enough
      // to need a textarea, a string limit is a plain maxlength attribute.
      max = maxOf(resolved);
      kind = resolved.name === 'bytes' && max !== null && max > 512 ? 'textarea' : 'text';
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
    const op = svc.contract.find((item) => item.name === opName && item.kind === 'op' && (item.isPublic || item.auth));
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
  // HEAD is body-less too: its parameters belong in the query string.
  const readsQuery = route.method === 'GET' || route.method === 'DELETE' || route.method === 'HEAD';
  const params = op.params.map((param) => {
    const where = pathNames.includes(param.name) ? 'path' : readsQuery ? 'query' : 'body';
    return uiParam(mod, param, where);
  });
  const returns = op.returns ? op.returns.kind : 'void';
  return { name: op.name, method: route.method, path: route.path, params, returns };
}

// The first screen is the first public GET operation that needs no path
// parameter: the service can call it with no input, so an ssr page can ship
// its result inside the HTML instead of asking the browser to fetch it again.
export function ssrFirstScreenOp(mod: ModuleNode): string | null {
  const ui = mod.uis[0];
  const svc = pickService(mod);
  if (!ui || !svc) return null;
  const wanted = new Set(ui.uses.map((entry) => entry.split('.').pop() ?? entry));
  for (const op of svc.contract) {
    if (op.kind !== 'op' || (!op.isPublic && !op.auth)) continue;
    if (wanted.size > 0 && !wanted.has(op.name)) continue;
    const route = routeOfOp(op);
    if (route.method !== 'GET' || route.path.includes(':')) continue;
    return op.name;
  }
  return null;
}

export function emitWeb(mod: ModuleNode, options: WebOptions): string {
  const ui = mod.uis[0];
  if (!ui) throw new Error('no ui block declared; add ui <Name> { ... } to generate a frontend');
  const svc = pickService(mod);
  if (!svc) throw new Error('no service to emit web for');

  const wanted = new Set(ui.uses.map((entry) => entry.split('.').pop() ?? entry));
  const ops = svc.contract
    .filter((op) => op.kind === 'op' && (op.isPublic || op.auth))
    .filter((op) => wanted.size === 0 || wanted.has(op.name))
    .map((op) => describeOp(mod, op));

  if (ops.length === 0) throw new Error('ui block names no public operation');

  const hasAuth = svc.uses.some((use) => use.capability === 'identity' || use.capability.endsWith('.identity'));
  const guarded = isGuarded(svc);

  const locale = ui.locale ?? ui.locales?.[0] ?? 'en';
  const theme = ui.theme ?? 'auto';
  const catalogs = ui.locales ? Object.fromEntries(ui.locales.map((tag) => [tag, pageStrings(tag)])) : null;
  const withLang = (html: string) => fillAll(html, {
    __LANG_RUNTIME__: LANG_RUNTIME,
    __CATALOGS__: jsonForScript(catalogs),
    __LOCALES__: jsonForScript(ui.locales ?? null),
  });

  if (ui.layout === 'presentation') {
    const live = presentationOps(mod, svc, ui);
    const deck = {
      title: options.title ?? ui.title ?? mod.name,
      stream: hasStream(svc),
      slides: ui.slides.map((slide) => ({
        title: slide.title,
        body: slide.body,
      })),
    };
    return fillAll(withLang(PRESENTATION_PAGE), {
      __LANG__: escapeHtml(locale),
      __STRINGS__: jsonForScript(pageStrings(locale)),
      __TITLE__: escapeHtml(options.title ?? ui.title ?? mod.name),
      __DECK__: jsonForScript(deck),
      __OPS__: jsonForScript(live),
      __HAS_AUTH__: hasAuth || guarded ? 'true' : 'false',
      // Third-party generated code goes in last: a marker inside it must not
      // be rewritten by a later insertion.
      __QR__: QR_SOURCE,
    });
  }

  if (ui.layout === 'chat') {
    const chat = chatOps(mod, svc, ui);
    return fillAll(withLang(CHAT_PAGE), {
      __LANG__: escapeHtml(locale),
      __STRINGS__: jsonForScript(pageStrings(locale)),
      __TITLE__: escapeHtml(options.title ?? ui.title ?? mod.name),
      __LEAD__: escapeHtml(mod.name + '@' + mod.version + ' · ' + svc.name + ' · chat with the model'),
      __CHAT_OPS__: jsonForScript(chat),
      __HAS_AUTH__: hasAuth || guarded ? 'true' : 'false',
    });
  }

  const ssrOp = ui.render === 'ssr' ? ssrFirstScreenOp(mod) : null;
  return fillAll(withLang(PAGE), {
    __LANG__: escapeHtml(locale),
    __THEME__: escapeHtml(theme),
    __STRINGS__: jsonForScript(pageStrings(locale)),
    __CATALOGS__: jsonForScript(catalogs),
    __LOCALES__: jsonForScript(ui.locales ?? null),
    __TITLE__: escapeHtml(options.title ?? ui.title ?? mod.name),
    __LEAD__: escapeHtml(mod.name + '@' + mod.version + ' · ' + svc.name + ' · operations: ' + ops.length),
    __OPS__: jsonForScript(ops),
    // The service swaps this marker for the first-screen result; a static page
    // carries no marker at all, so nothing can be left unsubstituted.
    __SSR__: ssrOp
      ? '{"op":' + JSON.stringify(ssrOp) + ',"data":__ARC_SSR_DATA__}'
      : '{"op":null,"data":null}',
    __HAS_AUTH__: hasAuth || guarded ? 'true' : 'false',
  });
}

// Insertions carry author text or JSON built from it, so they must land
// literally: a replacement *string* reads `$&`, `$'` and ``$` `` as patterns,
// which turned a slide body saying `Price $&` into a re-inserted `__DECK__`
// and spliced the rest of the document in at ``$` ``. A marker inserted by an
// earlier value is still substituted by a later one, so the order matters.
function fillAll(html: string, values: Record<string, string>): string {
  let out = html;
  for (const [marker, value] of Object.entries(values)) out = out.split(marker).join(value);
  return out;
}

// A slide title is author-written text, but it still lands inside a <script>:
// '$' and backslashes are fine, a closing tag is not.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c');
}

// The page is told which operation creates a session, which one brings a guest
// in, which one reports the live state and which one moves the deck. The
// bindings are explicit and never guessed.
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
    const op = svc.contract.find((item) => item.name === opName && item.kind === 'op' && (item.isPublic || item.auth));
    return op ? compact(describeOp(mod, op)) : null;
  };
  const ops: Record<string, unknown> = {
    start: find(ui.start),
    join: find(ui.join),
    state: find(ui.state),
    advance: find(ui.advance),
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
