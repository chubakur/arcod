// OpenAI-compatible chat client, hand-written: the generated service stays
// dependency-free and works with a local model or a cloud endpoint.
export const LLM_SOURCE = `// ---------- llm ----------

let LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://host.docker.internal:11434/v1';
while (LLM_BASE_URL.endsWith('/')) LLM_BASE_URL = LLM_BASE_URL.slice(0, -1);
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:7b';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);

// arcod test runs on a machine with no model. LLM_DRIVER=memory answers
// locally: the reply is deterministic and the embedding is a stable
// pseudo-random vector of the declared width. It tests the wiring, not a
// similarity model - the test runner picks this driver, a deployment does not.
const LLM_DRIVER = process.env.LLM_DRIVER || 'http';

function llmMemoryVector(text) {
  let seed = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    seed = ((seed ^ text.charCodeAt(index)) * 16777619) >>> 0;
  }
  const width = LLM_EMBED_DIM || 8;
  const vector = [];
  for (let index = 0; index < width; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    vector.push(Math.round((seed % 2001) - 1000) / 1000);
  }
  return vector;
}

// The kind names what to do next, not what happened. rejected: a repeat will\n// not help until the configuration changes. limited: repeat later, honouring\n// retryAfterMs when the endpoint sent Retry-After. unknown: no hint, the\n// service decides. No kind claims the first attempt left no trace: a proxy, a\n// quota or a gateway queue can answer 429 after the run started, so a repeat\n// may create a second run.\nfunction llmErrorKind(status) {\n  if (status === 429) return 'limited';\n  if (status >= 400 && status < 500) return 'rejected';\n  return 'unknown';\n}\n// Retry-After is seconds or an HTTP date; anything else carries no hint and
// the field stays absent (0 would read as repeat-now).
function llmRetryAfterMs(response) {
  const raw = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  const when = Date.parse(text);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}
function llmError(kind, message, status, body, retryAfterMs) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status === undefined ? null : status;
  error.body = body === undefined || body === null ? '' : String(body).slice(0, 300);
  if (retryAfterMs !== null && retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

function llmModel() {
  return LLM_MODEL;
}

// Embeddings ride the same OpenAI-compatible endpoint: Ollama and cloud
// routers both answer POST /embeddings with { data: [{ index, embedding }] }.
// The body never names a provider or a dimension; it asks for vectors.
const LLM_EMBED_MODEL = process.env.LLM_EMBED_MODEL || LLM_MODEL;
// dim is declared by the spec (bind llm(dim: 768)) and travels as env; 0 means
// "not declared", so the runtime only enforces consistency between vectors.
const LLM_EMBED_DIM = Number(process.env.LLM_EMBED_DIM || 0) || 0;

async function llmEmbed(texts) {
  const input = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item));
  // An empty batch is not a question: OpenAI-compatible endpoints reject
  // input: [] with 400, so an indexer that found nothing to embed used to fail
  // instead of doing nothing.
  if (input.length === 0) return [];
  if (LLM_DRIVER === 'memory') return input.map((text) => llmMemoryVector(text));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(LLM_BASE_URL + '/embeddings', {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        LLM_API_KEY ? { authorization: 'Bearer ' + LLM_API_KEY } : {},
      ),
      body: JSON.stringify({ model: LLM_EMBED_MODEL, input }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw llmError(llmErrorKind(response.status), 'llm: ' + response.status + ' ' + text.slice(0, 300), response.status, text, llmRetryAfterMs(response));
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw llmError('unknown', 'llm: invalid json: ' + text.slice(0, 200));
    }
    if (!data || !Array.isArray(data.data)) throw llmError('unknown', 'llm: no embeddings in response');
    const vectors = data.data
      .slice()
      .sort((left, right) => Number(left.index) - Number(right.index))
      .map((row) => (Array.isArray(row.embedding) ? row.embedding.map(Number) : []));
    // The declared width is a promise to every reader of these vectors: a
    // shorter or longer one cannot be compared or stored next to the rest.
    const expected = LLM_EMBED_DIM || (vectors.length > 0 ? vectors[0].length : 0);
    for (const vector of vectors) {
      if (vector.length !== expected) {
        throw llmError(
          'unknown',
          'llm: embedding dim ' + vector.length + ' does not match declared dim ' + expected +
          (LLM_EMBED_DIM ? '' : ' of the first vector'),
        );
      }
    }
    return vectors;
  } catch (error) {
    if (error && error.name === 'AbortError') throw llmError('unknown', 'llm: timeout after ' + LLM_TIMEOUT_MS + 'ms');
    if (error && !error.kind) throw llmError('unknown', String(error && error.message ? error.message : error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Tools travel with the request: the body declares what the model may ask
// for, and the reply carries the calls instead of prose. Two input shapes
// are accepted - the provider's { type, function } envelope and the short
// { name, description, parameters } - so a body does not repeat 'function'.
function llmToolList(tools) {
  if (!Array.isArray(tools)) return [];
  const list = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.function && typeof tool.function === 'object') {
      if (typeof tool.function.name === 'string' && tool.function.name !== '') list.push(tool);
      continue;
    }
    if (typeof tool.name !== 'string' || tool.name === '') continue;
    list.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      },
    });
  }
  return list;
}

// arguments arrives as JSON text; a body wants the object. A model that emits
// broken JSON keeps its text, so the caller can log or retry instead of the
// whole operation failing on our parse.
function llmToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return [];
  const calls = [];
  for (const call of message.tool_calls) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function && typeof call.function === 'object' ? call.function : {};
    if (typeof fn.name !== 'string' || fn.name === '') continue;
    let args = fn.arguments;
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        args = parsed && typeof parsed === 'object' ? parsed : fn.arguments;
      } catch (error) {
        args = fn.arguments;
      }
    } else if (!args || typeof args !== 'object') {
      args = {};
    }
    calls.push({ id: typeof call.id === 'string' ? call.id : '', name: fn.name, arguments: args });
  }
  return calls;
}

async function llmChat(messages, system, tools) {
  const list = Array.isArray(messages) ? messages : [];
  const toolList = llmToolList(tools);
  if (LLM_DRIVER === 'memory') {
    const last = list.length > 0 ? list[list.length - 1] : null;
    const asked = last && typeof last.content === 'string' ? last.content : '';
    // The offline driver answers prose: it proves the wiring, it does not
    // pretend to choose a tool.
    return { content: 'memory: ' + asked, model: 'memory', usage: { prompt: 0, completion: 0, total: 0 }, toolCalls: [] };
  }
  const payload = {
    model: LLM_MODEL,
    messages: system
      ? [{ role: 'system', content: String(system) }].concat(list)
      : list,
    stream: false,
  };
  // No tools, no field: an endpoint that never saw the key keeps the old
  // request byte for byte.
  if (toolList.length > 0) payload.tools = toolList;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(LLM_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        LLM_API_KEY ? { authorization: 'Bearer ' + LLM_API_KEY } : {},
      ),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw llmError(llmErrorKind(response.status), 'llm: ' + response.status + ' ' + text.slice(0, 300), response.status, text, llmRetryAfterMs(response));
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw llmError('unknown', 'llm: invalid json: ' + text.slice(0, 200));
    }
    const message = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : null;
    const toolCalls = llmToolCalls(message);
    const raw = message ? message.content : null;
    // A model that asks for a tool sends no prose at all (OpenAI sends null),
    // so content becomes '' instead of failing the operation; the caller
    // branches on toolCalls.length.
    const content = typeof raw === 'string' ? raw : toolCalls.length > 0 ? '' : null;
    if (content === null) throw llmError('unknown', 'llm: no content in response');
    // A provider that bills tokens reports usage; one that does not (a local
    // runner, a mock) answers zeros, so a budget body never does arithmetic on
    // undefined (B118).
    const rawUsage = data && data.usage && typeof data.usage === 'object' ? data.usage : {};
    const count = (value) => {
      const number = Math.trunc(Number(value));
      return Number.isFinite(number) && number > 0 ? number : 0;
    };
    const usage = {
      prompt: count(rawUsage.prompt_tokens),
      completion: count(rawUsage.completion_tokens),
      total: count(rawUsage.total_tokens),
    };
    if (usage.total === 0) usage.total = usage.prompt + usage.completion;
    return { content, model: data.model || LLM_MODEL, usage, toolCalls };
  } catch (error) {
    if (error && error.name === 'AbortError') throw llmError('unknown', 'llm: timeout after ' + LLM_TIMEOUT_MS + 'ms');
    if (error && !error.kind) throw llmError('unknown', String(error && error.message ? error.message : error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
`;
