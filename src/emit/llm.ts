// OpenAI-compatible chat client, hand-written: the generated service stays
// dependency-free and works with a local model or a cloud endpoint.
export const LLM_SOURCE = `// ---------- llm ----------

let LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://host.docker.internal:11434/v1';
while (LLM_BASE_URL.endsWith('/')) LLM_BASE_URL = LLM_BASE_URL.slice(0, -1);
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:7b';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);

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
    if (!response.ok) throw new Error('llm: ' + response.status + ' ' + text.slice(0, 300));
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('llm: invalid json: ' + text.slice(0, 200));
    }
    if (!data || !Array.isArray(data.data)) throw new Error('llm: no embeddings in response');
    const vectors = data.data
      .slice()
      .sort((left, right) => Number(left.index) - Number(right.index))
      .map((row) => (Array.isArray(row.embedding) ? row.embedding.map(Number) : []));
    // The declared width is a promise to every reader of these vectors: a
    // shorter or longer one cannot be compared or stored next to the rest.
    const expected = LLM_EMBED_DIM || (vectors.length > 0 ? vectors[0].length : 0);
    for (const vector of vectors) {
      if (vector.length !== expected) {
        throw new Error(
          'llm: embedding dim ' + vector.length + ' does not match declared dim ' + expected +
          (LLM_EMBED_DIM ? '' : ' of the first vector'),
        );
      }
    }
    return vectors;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('llm: timeout after ' + LLM_TIMEOUT_MS + 'ms');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function llmChat(messages, system) {
  const list = Array.isArray(messages) ? messages : [];
  const payload = {
    model: LLM_MODEL,
    messages: system
      ? [{ role: 'system', content: String(system) }].concat(list)
      : list,
    stream: false,
  };
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
    if (!response.ok) throw new Error('llm: ' + response.status + ' ' + text.slice(0, 300));
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('llm: invalid json: ' + text.slice(0, 200));
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof content !== 'string') throw new Error('llm: no content in response');
    return { content, model: data.model || LLM_MODEL };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('llm: timeout after ' + LLM_TIMEOUT_MS + 'ms');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
`;
