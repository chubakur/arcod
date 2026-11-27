// Outbound HTTP for a body, hand-written: the generated service stays
// dependency-free. One alias, one base URL: the binding decides the host, so a
// body can only choose the path. An absolute URL, a protocol-relative //host or
// a scheme prefix is the caller trying to reach another host, and the adapter
// answers Forbidden before a byte leaves the service.
export function endpointSource(bindings: Record<string, string>): string {
  const table = Object.entries(bindings)
    .map(([alias, env]) => JSON.stringify(alias) + ': process.env.' + env + " || ''")
    .join(', ');
  return [
    '// ---------- endpoint ----------',
    '',
    'const ENDPOINT_URLS = { ' + table + ' };',
    "const ENDPOINT_TIMEOUT_MS = Number(process.env.ENDPOINT_TIMEOUT_MS || 15000);",
    "const ENDPOINT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);",
    '',
    'function endpointError(kind, message) {',
    '  const error = new Error(message);',
    '  error.error = kind;',
    '  return error;',
    '}',
    '',
    'function endpointTarget(alias, method, path) {',
    "  const base = Object.prototype.hasOwnProperty.call(ENDPOINT_URLS, alias) ? ENDPOINT_URLS[alias] : '';",
    "  if (!base) throw endpointError('Unavailable', 'endpoint ' + JSON.stringify(alias) + ' has no URL bound');",
    "  const verb = String(method || 'GET').toUpperCase();",
    "  if (!ENDPOINT_METHODS.has(verb)) throw endpointError('Invalid', 'endpoint: unsupported method ' + JSON.stringify(String(method)));",
    "  const tail = path === null || path === undefined ? '' : String(path);",
    "  if (!tail.startsWith('/') || tail.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(tail)) {",
    "    throw endpointError('Forbidden', 'endpoint: the path must stay on the bound host, got ' + JSON.stringify(tail));",
    '  }',
    "  return { url: base.replace(/\\/+$/, '') + tail, method: verb };",
    '}',
    '',
    'async function endpointCall(alias, method, path, body, headers) {',
    '  const target = endpointTarget(alias, method, path);',
    '  const controller = new AbortController();',
    '  const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);',
    '  try {',
    '    const init = { method: target.method, signal: controller.signal };',
    "    const sends = target.method !== 'GET' && target.method !== 'HEAD';",
    '    if (sends && body !== null && body !== undefined) {',
    "      init.body = typeof body === 'string' ? body : JSON.stringify(body);",
    "      init.headers = Object.assign({ 'content-type': 'application/json' }, headers && typeof headers === 'object' ? headers : {});",
    '    } else if (headers && typeof headers === \'object\') {',
    '      init.headers = headers;',
    '    }',
    '    const response = await fetch(target.url, init);',
    '    const text = await response.text();',
    '    return { status: response.status, body: text };',
    '  } catch (error) {',
    '    if (error && error.error) throw error;',
    "    if (error && error.name === 'AbortError') throw endpointError('Unavailable', 'endpoint: timeout after ' + ENDPOINT_TIMEOUT_MS + 'ms');",
    "    throw endpointError('Unavailable', 'endpoint: ' + String(error && error.message ? error.message : error));",
    '  } finally {',
    '    clearTimeout(timer);',
    '  }',
    '}',
    '',
  ].join('\n');
}
