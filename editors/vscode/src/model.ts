// Pure helpers: no vscode import, so they can be tested with node --test.
export type CompletionKind = 'keyword' | 'type' | 'error' | 'service' | 'operation' | 'value' | 'property';

export interface CompletionSpec {
  label: string;
  kind: CompletionKind;
  detail?: string;
  sortText?: string;
}

export interface RawDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  file: string;
  range: { line: number; col: number; endLine: number; endCol: number };
  path?: string;
  hint?: string;
}

export interface MappedDiagnostic {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: 'error' | 'warning';
  message: string;
  code: string;
}

// CLI positions are 1-based; TextDocument positions are 0-based. Clamp to the
// actual line length so a stale range never crashes the editor.
export function mapDiagnostics(raw: RawDiagnostic[], lines: string[]): MappedDiagnostic[] {
  const lastLine = Math.max(0, lines.length - 1);
  return raw.map((item) => {
    const line = Math.min(Math.max(0, item.range.line - 1), lastLine);
    const endLine = Math.min(Math.max(line, item.range.endLine - 1), lastLine);
    const startText = lines[line] ?? '';
    const endText = lines[endLine] ?? '';
    const col = Math.min(Math.max(0, item.range.col - 1), startText.length);
    const endCol = Math.min(Math.max(col, item.range.endCol - 1), endText.length);
    return {
      line,
      col,
      endLine,
      endCol,
      severity: item.severity,
      code: item.code,
      message: item.hint ? item.message + ' — ' + item.hint : item.message,
    };
  });
}

export interface SymbolSpec {
  name: string;
  kind: 'module' | 'service' | 'workflow' | 'environment' | 'ui' | 'type' | 'error' | 'enum' | 'operation' | 'step';
  line: number;
  container?: string;
}

export const KEYWORDS: Array<[string, string]> = [
  ['module', 'объявление модуля'],
  ['meta', 'метаданные модуля'],
  ['use', 'подключить возможность или модуль'],
  ['capability', 'вид подключения'],
  ['type', 'объявление типа'],
  ['error', 'объявление ошибки'],
  ['enum', 'объявление перечисления'],
  ['service', 'сервис'],
  ['external', 'внешний сервис'],
  ['contract', 'контракт сервиса'],
  ['op', 'операция'],
  ['job', 'одиночная задача'],
  ['step', 'шаг workflow'],
  ['workflow', 'граф фоновых задач'],
  ['trigger', 'триггер workflow'],
  ['needs', 'зависимости шага'],
  ['call', 'тело шага — операция'],
  ['onFail', 'политика отказа'],
  ['effects', 'разрешённые эффекты'],
  ['allow', 'разрешить эффект'],
  ['deny', 'запретить эффект'],
  ['rules', 'правила сервиса'],
  ['invariant', 'инвариант'],
  ['atomic', 'атомарность'],
  ['examples', 'примеры'],
  ['lifecycle', 'жизненный цикл'],
  ['ui', 'интерфейс'],
  ['layout', 'вид интерфейса'],
  ['environment', 'окружение'],
  ['bind', 'привязка возможности'],
  ['deploy', 'провайдер развёртывания'],
  ['public', 'публичная операция'],
  ['route', 'HTTP-маршрут'],
  ['errors', 'ошибки операции'],
  ['post', 'постусловие'],
  ['pre', 'предусловие'],
  ['idempotent', 'операцию можно повторять'],
  ['true', 'истина'],
  ['false', 'ложь'],
  ['null', 'пусто'],
];

export const TYPES = ['uuid', 'string', 'bytes', 'int', 'bool', 'float', 'list', 'map', 'record', 'json', 'void'];
export const CAPABILITIES = ['kv', 'sql', 'queue', 'ids', 'http', 'clock', 'lock', 'search', 'blob', 'mail', 'identity', 'llm'];
export const PROVIDERS = [
  'redis', 'postgres', 'mysql', 'mariadb', 'mongo', 'rabbitmq', 'kafka',
  'keycloak', 's3', 'minio', 'ollama', 'openai', 'local',
];
export const DEPLOY_PROVIDERS = ['docker', 'aws', 'yandex', 'kubernetes'];
export const LAYOUTS = ['forms', 'chat'];
export const OVERLAP = ['skip', 'queue', 'parallel'];
export const CATCHUP = ['none', 'last', 'all'];
export const ON_FAIL = ['stop', 'skip', 'retry', 'continue'];
export const UI_KINDS = ['spa'];

const key = (label: string, kind: CompletionKind, detail?: string, sortText?: string): CompletionSpec => ({ label, kind, detail, sortText });

export function symbolsFromText(text: string): SymbolSpec[] {
  const out: SymbolSpec[] = [];
  const lines = text.split(/\r?\n/);
  let container: string | undefined;
  let containerIndent = -1;

  lines.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    if (container && indent <= containerIndent && line.trim() === '}') {
      container = undefined;
    }
    let match = /^\s*module\s+([A-Za-z_][\w-]*)/.exec(line);
    if (match) { out.push({ name: match[1], kind: 'module', line: index }); return; }
    match = /^\s*(service|external|workflow|environment|ui|type|error|enum)\s+([A-Za-z_][\w-]*)/.exec(line);
    if (match) {
      const kind = match[1] === 'external' ? 'service' : (match[1] as SymbolSpec['kind']);
      out.push({ name: match[2], kind, line: index });
      container = kind === 'service' ? match[2] : undefined;
      containerIndent = indent;
      return;
    }
    match = /^\s*(public\s+)?(op|job)\s+([A-Za-z_][\w-]*)/.exec(line) ?? /^\s*step\s+([A-Za-z_][\w-]*)/.exec(line);
    if (match) {
      const name = match.length === 4 ? match[3] : match[1];
      out.push({ name, kind: 'operation', line: index, container });
    }
  });

  return out;
}

export function completionsFor(lineBeforeCursor: string, prefix: string, symbols: SymbolSpec[]): CompletionSpec[] {
  const before = lineBeforeCursor;

  if (/\buses\s+[A-Za-z_][\w]*\s*:\s*[\w.]*$/.test(before)) {
    return CAPABILITIES.map((name, i) => key(name, 'value', 'возможность', '0' + i));
  }
  if (/\buse\s+capability\s+[\w.]*$/.test(before)) {
    return CAPABILITIES.map((name, i) => key('arcod.std.' + name, 'value', 'стандартная возможность', '0' + i));
  }
  if (/\bbind\s+[A-Za-z_][\w]*\s*->\s*[\w]*$/.test(before)) {
    return [...PROVIDERS, ...DEPLOY_PROVIDERS].map((name, i) => key(name, 'value', 'провайдер', '0' + i));
  }
  if (/\bdeploy\s+[\w]*$/.test(before)) {
    return DEPLOY_PROVIDERS.map((name, i) => key(name, 'value', 'провайдер развёртывания', '0' + i));
  }
  if (/\blayout\s*:\s*[\w]*$/.test(before)) {
    return LAYOUTS.map((name, i) => key(name, 'value', 'вид интерфейса', '0' + i));
  }
  if (/\boverlap\s*:\s*[\w]*$/.test(before)) {
    return OVERLAP.map((name, i) => key(name, 'value', 'политика перекрытия', '0' + i));
  }
  if (/\bcatchup\s*:\s*[\w]*$/.test(before)) {
    return CATCHUP.map((name, i) => key(name, 'value', 'политика пропусков', '0' + i));
  }
  if (/\bonFail\s*:\s*[\w]*$/.test(before)) {
    return ON_FAIL.map((name, i) => key(name, 'value', 'политика отказа', '0' + i));
  }
  if (/\bkind\s*:\s*[\w]*$/.test(before)) {
    return UI_KINDS.map((name, i) => key(name, 'value', 'вид интерфейса', '0' + i));
  }
  if (/\btrigger\s+[\w]*$/.test(before)) {
    return ['cron', 'event', 'manual', 'after'].map((name, i) => key(name, 'value', 'триггер', '0' + i));
  }

  const items: CompletionSpec[] = [];
  TYPES.forEach((name, i) => items.push(key(name, 'type', 'примитивный тип', '1' + String(i).padStart(2, '0'))));
  KEYWORDS.forEach(([name, detail], i) => items.push(key(name, 'keyword', detail, '2' + String(i).padStart(2, '0'))));

  const seen = new Set(items.map((item) => item.label));
  for (const symbol of symbols) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    const kind: CompletionKind = symbol.kind === 'type' ? 'type'
      : symbol.kind === 'error' ? 'error'
      : symbol.kind === 'operation' ? 'operation'
      : symbol.kind === 'service' ? 'service'
      : 'value';
    items.push(key(symbol.name, kind, symbol.kind, '0' + symbol.line));
  }

  const needle = prefix.toLowerCase();
  return items
    .filter((item) => needle === '' || item.label.toLowerCase().startsWith(needle) || item.label.toLowerCase().includes(needle))
    .slice(0, 200);
}
